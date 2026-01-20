const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

/**
 * Dashboard API para MEG_PEDIDO / MEG_PEDIDO_ITEM
 *
 * IMPORTANTE: não coloque suas credenciais no HTML.
 * Configure via variáveis de ambiente:
 *   PGHOST=...
 *   PGPORT=...
 *   PGDATABASE=...
 *   PGUSER=...
 *   PGPASSWORD=...
 */

const app = express();
app.use(cors());
app.use(express.json());

// Sirva o HTML estático (coloque mercado_dashboard_pg.html dentro de ./public)
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool();

function isoDateOnly(d) {
  // YYYY-MM-DD
  if (!d) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d))) return null;
  return String(d);
}

app.get('/api/meg/dashboard', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  const dateStart = isoDateOnly(req.query.dateStart);
  const dateEnd = isoDateOnly(req.query.dateEnd);
  const status = (req.query.status || 'AGUARDANDO ENTREGA').toString().trim();
  const cliente = (req.query.cliente || '').toString().trim();
  const pedidoId = (req.query.pedidoId || '').toString().trim();
  const produto = (req.query.produto || '').toString().trim();

  try {
    // Monta filtros com parâmetros
    const where = [];
    const params = [];

    // Datas (inclusivo no fim: usa < end + 1 dia)
    if (dateStart) {
      params.push(dateStart);
      where.push(`data >= $${params.length}::date`);
    }
    if (dateEnd) {
      params.push(dateEnd);
      // < end + 1 dia
      where.push(`data < ($${params.length}::date + interval '1 day')`);
    }

    if (status) {
      params.push(status);
      where.push(`status = $${params.length}`);
    }

    if (cliente) {
      params.push(cliente);
      where.push(`cliente = $${params.length}`);
    }

    if (pedidoId) {
      const pidNum = Number(pedidoId);
      if (!Number.isFinite(pidNum)) {
        return res.status(400).json({ error: 'pedidoId inválido' });
      }
      params.push(pidNum);
      where.push(`id = $${params.length}`);
    }

    const sqlPedidos = `
      SELECT id, data, cliente, nome, endereco, total, status, step
      FROM meg_pedido
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY data ASC, id ASC
    `;

    const pedidosResult = await pool.query(sqlPedidos, params);
    const pedidos = pedidosResult.rows;

    // Itens
    let itens = [];
    if (pedidos.length) {
      const ids = pedidos.map(p => p.id);
      const itParams = [ids];
      let itWhere = `pedido_id = ANY($1::int[])`;

      if (produto) {
        itParams.push(produto);
        itWhere += ` AND produto = $2`;
      }

      const sqlItens = `
        SELECT id, data, produto, preco, quantidade, status, pedido_id
        FROM meg_pedido_item
        WHERE ${itWhere}
        ORDER BY data ASC, pedido_id ASC
      `;

      const itensResult = await pool.query(sqlItens, itParams);
      itens = itensResult.rows;
    }

    return res.json({ pedidos, itens });
  } catch (err) {
    console.error('Erro /api/meg/dashboard:', err);
    return res.status(500).json({ error: 'Erro interno ao buscar dados do dashboard' });
  }
});

// Marcar pedido como ENTREGUE
// Atualiza meg_pedido.status e (por consistência) também meg_pedido_item.status do mesmo pedido.
app.post('/api/meg/pedido/:id/entregar', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  const idRaw = (req.params.id || '').toString().trim();
  const pid = Number(idRaw);
  if (!Number.isFinite(pid)) {
    return res.status(400).json({ error: 'ID de pedido inválido' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const upPedido = await client.query(
      `UPDATE meg_pedido
       SET status = 'ENTREGUE'
       WHERE id = $1
       RETURNING id, status`,
      [pid]
    );

    if (upPedido.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pedido não encontrado' });
    }

    // Atualiza itens (não é obrigatório, mas ajuda a manter tudo coerente)
    await client.query(
      `UPDATE meg_pedido_item
       SET status = 'ENTREGUE'
       WHERE pedido_id = $1`,
      [pid]
    );

    await client.query('COMMIT');
    return res.json(upPedido.rows[0]);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Erro /api/meg/pedido/:id/entregar:', err);
    return res.status(500).json({ error: 'Erro interno ao atualizar status do pedido' });
  } finally {
    client.release();
  }
});

// Raiz -> abre o dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'mercado_dashboard_pg.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Dashboard MEG rodando na porta ${PORT}`);
});
