import { Hono } from 'hono'

const app = new Hono<{ Bindings: Env }>()

type HomeRow = { id: string; name: string }
type MemberRow = { id: string; home_id: string; name: string }
type ShareRow = {
  id: string
  member_id: string
  amount_cents: number
  paid_at: string | null
  idempotency_key: string | null
}
type BalanceRow = {
  member_id: string
  name: string
  outstanding_cents: number | null
}
type JsonBody = Record<string, unknown>

function isObject(value: unknown): value is JsonBody {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

app.get('/api/health', (c) => c.json({ status: 'ok' }))

app.onError((err, c) => {
  console.error(err)
  return c.json({ error: 'Internal server error' }, 500)
})

app.post('/api/homes', async (c) => {
  const body: unknown = await c.req.json().catch(() => null)
  if (!isObject(body) || !isNonEmptyString(body.name)) {
    return c.json({ error: 'A valid home name is required' }, 422)
  }

  const home: HomeRow = {
    id: crypto.randomUUID(),
    name: body.name.trim(),
  }

  await c.env.DB.prepare('INSERT INTO homes (id, name) VALUES (?, ?)')
    .bind(home.id, home.name)
    .run()

  return c.json(home, 201)
})

app.post('/api/homes/:homeId/members', async (c) => {
  const homeId = c.req.param('homeId')
  const body: unknown = await c.req.json().catch(() => null)

  if (!isObject(body) || !isNonEmptyString(body.name)) {
    return c.json({ error: 'A valid member name is required' }, 422)
  }

  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<{ id: string }>()

  if (!home) return c.json({ error: 'Home not found' }, 404)

  const member: MemberRow = {
    id: crypto.randomUUID(),
    home_id: homeId,
    name: body.name.trim(),
  }

  await c.env.DB.prepare('INSERT INTO members (id, home_id, name) VALUES (?, ?, ?)')
    .bind(member.id, member.home_id, member.name)
    .run()

  return c.json({ id: member.id, homeId: member.home_id, name: member.name }, 201)
})

app.post('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')
  const body: unknown = await c.req.json().catch(() => null)

  if (
    !isObject(body) ||
    !isNonEmptyString(body.title) ||
    typeof body.totalCents !== 'number' ||
    !Number.isSafeInteger(body.totalCents) ||
    body.totalCents <= 0
  ) {
    return c.json({ error: 'A valid title and positive integer totalCents are required' }, 422)
  }

  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<{ id: string }>()

  if (!home) return c.json({ error: 'Home not found' }, 404)

  const members = await c.env.DB.prepare(
    'SELECT id FROM members WHERE home_id = ? ORDER BY rowid ASC',
  )
    .bind(homeId)
    .all<{ id: string }>()

  if (members.results.length === 0) {
    return c.json({ error: 'Cannot create a bill for a home with no members' }, 422)
  }

  const billId = crypto.randomUUID()
  const title = body.title.trim()
  const totalCents = body.totalCents
  const baseShare = Math.floor(totalCents / members.results.length)
  const remainder = totalCents % members.results.length

  await c.env.DB.prepare('INSERT INTO bills (id, home_id, title, total_cents) VALUES (?, ?, ?, ?)')
    .bind(billId, homeId, title, totalCents)
    .run()

  const shares: {
    id: string
    memberId: string
    amountCents: number
    paidAt: null
  }[] = []

  for (const [index, member] of members.results.entries()) {
    const share = {
      id: crypto.randomUUID(),
      memberId: member.id,
      amountCents: baseShare + (index < remainder ? 1 : 0),
      paidAt: null,
    }

    await c.env.DB.prepare(
      'INSERT INTO shares (id, bill_id, member_id, amount_cents) VALUES (?, ?, ?, ?)',
    )
      .bind(share.id, billId, share.memberId, share.amountCents)
      .run()

    shares.push(share)
  }

  return c.json({ id: billId, homeId, title, totalCents, shares }, 201)
})

app.post('/api/bills/:billId/shares/:shareId/pay', async (c) => {
  const billId = c.req.param('billId')
  const shareId = c.req.param('shareId')
  const key = c.req.header('Idempotency-Key')

  if (!key?.trim()) {
    return c.json({ error: 'Idempotency-Key header is required' }, 400)
  }

  const share = await c.env.DB.prepare(
    `SELECT s.id, s.member_id, s.amount_cents, s.paid_at, s.idempotency_key
     FROM shares s
     JOIN bills b ON b.id = s.bill_id
     WHERE b.id = ? AND s.id = ?`,
  )
    .bind(billId, shareId)
    .first<ShareRow>()

  if (!share) return c.json({ error: 'Bill or share not found' }, 404)

  if (share.paid_at !== null) {
    if (share.idempotency_key === key) {
      return c.json({
        id: share.id,
        memberId: share.member_id,
        amountCents: share.amount_cents,
        paidAt: share.paid_at,
      })
    }
    return c.json({ error: 'Share has already been paid' }, 409)
  }

  const paidAt = new Date().toISOString()
  const result = await c.env.DB.prepare(
    `UPDATE shares
     SET paid_at = ?, idempotency_key = ?
     WHERE id = ? AND bill_id = ? AND paid_at IS NULL`,
  )
    .bind(paidAt, key, shareId, billId)
    .run()

  if (result.meta.changes === 0) {
    const current = await c.env.DB.prepare(
      'SELECT id, member_id, amount_cents, paid_at, idempotency_key FROM shares WHERE id = ? AND bill_id = ?',
    )
      .bind(shareId, billId)
      .first<ShareRow>()

    if (!current) return c.json({ error: 'Bill or share not found' }, 404)

    if (current.paid_at !== null && current.idempotency_key === key) {
      return c.json({
        id: current.id,
        memberId: current.member_id,
        amountCents: current.amount_cents,
        paidAt: current.paid_at,
      })
    }

    return c.json({ error: 'Share has already been paid' }, 409)
  }

  return c.json({
    id: share.id,
    memberId: share.member_id,
    amountCents: share.amount_cents,
    paidAt,
  })
})

app.get('/api/homes/:homeId/balances', async (c) => {
  const homeId = c.req.param('homeId')

  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<{ id: string }>()

  if (!home) return c.json({ error: 'Home not found' }, 404)

  const result = await c.env.DB.prepare(
    `SELECT m.id AS member_id, m.name,
       COALESCE(SUM(CASE WHEN s.paid_at IS NULL THEN s.amount_cents ELSE 0 END), 0) AS outstanding_cents
     FROM members m
     LEFT JOIN shares s ON s.member_id = m.id
     LEFT JOIN bills b ON b.id = s.bill_id AND b.home_id = m.home_id
     WHERE m.home_id = ?
     GROUP BY m.id, m.name
     ORDER BY m.rowid ASC`,
  )
    .bind(homeId)
    .all<BalanceRow>()

  return c.json({
    balances: result.results.map((row) => ({
      memberId: row.member_id,
      name: row.name,
      outstandingCents: row.outstanding_cents ?? 0,
    })),
  })
})

export default app
