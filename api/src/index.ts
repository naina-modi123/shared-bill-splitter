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
app.get('/api/homes', async (c) => {
  const result = await c.env.DB.prepare(
    'SELECT id, name FROM homes ORDER BY rowid ASC',
  ).all<HomeRow>()

  return c.json(result.results)
})
app.get('/api/homes/:homeId/members', async (c) => {
  const homeId = c.req.param('homeId')

  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<{ id: string }>()

  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  const result = await c.env.DB.prepare(
    'SELECT id, home_id, name FROM members WHERE home_id = ? ORDER BY created_at ASC, rowid ASC',
  )
    .bind(homeId)
    .all<MemberRow>()

  return c.json({
    members: result.results.map((member) => ({
      id: member.id,
      homeId: member.home_id,
      name: member.name,
    })),
  })
})
app.get('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')

  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<{ id: string }>()

  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  const result = await c.env.DB.prepare(
    `SELECT
       b.id AS bill_id,
       b.home_id,
       b.title,
       b.total_cents,
       b.category,
       s.id AS share_id,
       s.member_id,
       s.amount_cents,
       s.paid_at
     FROM bills b
     LEFT JOIN shares s ON s.bill_id = b.id
     WHERE b.home_id = ?
     ORDER BY b.created_at ASC, b.rowid ASC, s.rowid ASC`,
  )
    .bind(homeId)
    .all<{
      bill_id: string
      home_id: string
      title: string
      total_cents: number
      category: string
      share_id: string | null
      member_id: string | null
      amount_cents: number | null
      paid_at: string | null
    }>()

  const bills = new Map<
    string,
    {
      id: string
      homeId: string
      title: string
      totalCents: number
      category: string
      shares: {
        id: string
        memberId: string
        amountCents: number
        paidAt: string | null
      }[]
    }
  >()

  for (const row of result.results) {
    let bill = bills.get(row.bill_id)

    if (!bill) {
      bill = {
        id: row.bill_id,
        homeId: row.home_id,
        title: row.title,
        totalCents: row.total_cents,
        category: row.category,
        shares: [],
      }
      bills.set(row.bill_id, bill)
    }

    if (row.share_id !== null && row.member_id !== null && row.amount_cents !== null) {
      bill.shares.push({
        id: row.share_id,
        memberId: row.member_id,
        amountCents: row.amount_cents,
        paidAt: row.paid_at,
      })
    }
  }

  return c.json({ bills: Array.from(bills.values()) })
})
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
app.delete('/api/homes/:homeId/members/:memberId', async (c) => {
  const homeId = c.req.param('homeId')
  const memberId = c.req.param('memberId')

  const member = await c.env.DB.prepare('SELECT id FROM members WHERE id = ? AND home_id = ?')
    .bind(memberId, homeId)
    .first<{ id: string }>()

  if (!member) {
    return c.json({ error: 'Member not found' }, 404)
  }

  const existingShares = await c.env.DB.prepare(
  `SELECT shares.id
   FROM shares
   JOIN bills ON bills.id = shares.bill_id
   WHERE shares.member_id = ?
     AND bills.home_id = ?
   LIMIT 1`,
)
  .bind(memberId, homeId)
  .first<{ id: string }>()

  if (existingShares) {
    return c.json({ error: 'Cannot remove a member who has existing bill shares' }, 409)
  }
  await c.env.DB.prepare('DELETE FROM members WHERE id = ? AND home_id = ?')
    .bind(memberId, homeId)
    .run()

  return c.json({ success: true })
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

  const validCategories = ['Food', 'Utilities', 'Travel', 'Shopping', 'Entertainment', 'Other']

  const category =
    typeof body.category === 'string' && validCategories.includes(body.category)
      ? body.category
      : 'Other'
  const baseShare = Math.floor(totalCents / members.results.length)
  const remainder = totalCents % members.results.length

  await c.env.DB.prepare(
    'INSERT INTO bills (id, home_id, title, total_cents, category) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(billId, homeId, title, totalCents, category)
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

  return c.json({ id: billId, homeId, title, totalCents, category, shares }, 201)
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
