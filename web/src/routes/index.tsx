import { createFileRoute } from '@tanstack/react-router'
import { type FormEvent, useCallback, useEffect, useState } from 'react'

const API_BASE = '/api'

type Home = { id: string; name: string }
type Member = { id: string; homeId: string; name: string }
type Share = {
  id: string
  memberId: string
  amountCents: number
  paidAt: string | null
}
type Bill = {
  id: string
  homeId: string
  title: string
  totalCents: number
  shares: Share[]
}
type Balance = {
  memberId: string
  name: string
  outstandingCents: number
}

export const Route = createFileRoute('/')({
  component: HomePage,
})

function money(cents: number) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(cents / 100)
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })

  const data: unknown = await response.json().catch(() => null)

  if (!response.ok) {
    const message =
      typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `Request failed (${response.status})`

    throw new Error(message)
  }

  return data as T
}

function HomePage() {
  const [home, setHome] = useState<Home | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [bills, setBills] = useState<Bill[]>([])
  const [balances, setBalances] = useState<Balance[]>([])
  const [homeName, setHomeName] = useState('')
  const [memberName, setMemberName] = useState('')
  const [billTitle, setBillTitle] = useState('')
  const [billAmount, setBillAmount] = useState('')
  const [loading, setLoading] = useState(false)
  const [creatingHome, setCreatingHome] = useState(false)
  const [creatingMember, setCreatingMember] = useState(false)
  const [creatingBill, setCreatingBill] = useState(false)
  const [payingShare, setPayingShare] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState('')
  const [successMessage, setSuccessMessage] = useState('')

  const refreshBalances = useCallback(async (homeId: string) => {
    const result = await request<{ balances: Balance[] }>(`/homes/${homeId}/balances`)
    setBalances(result.balances)
  }, [])

  useEffect(() => {
    setLoading(true)
    request<Home[]>('/homes')
      .then((result) => {
        if (result.length > 0) {
          setHome(result[0] ?? null)
        }
      })
      .catch(() => {
        // A new home can still be created if listing homes is unsupported.
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!home) {
      setMembers([])
      setBills([])
      setBalances([])
      return
    }

    let active = true
    const currentHome = home
    if (!currentHome) return
    async function loadHomeData() {
      setLoading(true)
      setErrorMessage('')

      try {
        const results = await Promise.all([
          request<{ members: Member[] }>(`/homes/${currentHome.id}/members`),
          request<{ bills?: Bill[] }>(`/homes/${currentHome.id}/bills`),
          request<{ balances: Balance[] }>(`/homes/${currentHome.id}/balances`),
        ])

        if (active) {
          setMembers(results[0].members)
          setBills(results[1].bills ?? [])
          setBalances(results[2].balances)
        }
      } catch (error) {
        if (active) {
          setErrorMessage(error instanceof Error ? error.message : 'Unable to load home data.')
        }
      } finally {
        if (active) setLoading(false)
      }
    }

    void loadHomeData()

    return () => {
      active = false
    }
  }, [home])

  async function createHome(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setCreatingHome(true)
    setErrorMessage('')
    setSuccessMessage('')

    try {
      const created = await request<Home>('/homes', {
        method: 'POST',
        body: JSON.stringify({ name: homeName }),
      })

      setHome(created)
      setMembers([])
      setBills([])
      setBalances([])
      setHomeName('')
      setSuccessMessage(`Home "${created.name}" created successfully.`)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not create home.')
    } finally {
      setCreatingHome(false)
    }
  }

  async function addMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!home) return

    setCreatingMember(true)
    setErrorMessage('')
    setSuccessMessage('')

    try {
      const member = await request<Member>(`/homes/${home.id}/members`, {
        method: 'POST',
        body: JSON.stringify({ name: memberName }),
      })

      setMembers((current) => [...current, member])
      setBalances((current) => [
        ...current,
        { memberId: member.id, name: member.name, outstandingCents: 0 },
      ])
      setMemberName('')
      setSuccessMessage(`${member.name} added to the home.`)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not add member.')
    } finally {
      setCreatingMember(false)
    }
  }

  async function createBill(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!home) return

    const rupees = Number(billAmount)
    if (!Number.isFinite(rupees) || rupees <= 0 || !Number.isSafeInteger(rupees * 100)) {
      setErrorMessage('Enter a valid bill amount greater than zero.')
      return
    }

    setCreatingBill(true)
    setErrorMessage('')
    setSuccessMessage('')

    try {
      const bill = await request<Bill>(`/homes/${home.id}/bills`, {
        method: 'POST',
        body: JSON.stringify({
          title: billTitle,
          totalCents: Math.round(rupees * 100),
        }),
      })

      setBills((current) => [...current, bill])
      setBillTitle('')
      setBillAmount('')
      await refreshBalances(home.id)
      setSuccessMessage('Bill created and split successfully.')
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not create bill.')
    } finally {
      setCreatingBill(false)
    }
  }

  async function payShare(billId: string, shareId: string) {
    if (!home) return

    setPayingShare(shareId)
    setErrorMessage('')
    setSuccessMessage('')

    try {
      const paid = await request<Share>(`/bills/${billId}/shares/${shareId}/pay`, {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
      })

      setBills((current) =>
        current.map((bill) =>
          bill.id !== billId
            ? bill
            : {
                ...bill,
                shares: bill.shares.map((share) =>
                  share.id === shareId ? { ...share, paidAt: paid.paidAt } : share,
                ),
              },
        ),
      )

      await refreshBalances(home.id)
      setSuccessMessage('Payment recorded successfully.')
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Payment failed. Please retry.')
    } finally {
      setPayingShare(null)
    }
  }

  const totalOutstanding = balances.reduce((total, balance) => total + balance.outstandingCents, 0)
  const paidShareCount = bills.reduce(
    (total, bill) => total + bill.shares.filter((share) => share.paidAt !== null).length,
    0,
  )
  const shareCount = bills.reduce((total, bill) => total + bill.shares.length, 0)

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">₹</span>
          <span>Splitwise Home</span>
        </div>
        <div className="topbar-note">Shared expenses, made simple.</div>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">YOUR SHARED HOME</p>
          <h1>Good homes run on shared responsibility.</h1>
          <p>Keep every bill organized, every share transparent, and everyone on the same page.</p>
        </div>
      </section>

      {errorMessage && (
        <div className="notice" role="alert">
          {errorMessage}
        </div>
      )}
      {successMessage && (
        <div className="notice notice-success" role="status">
          {successMessage}
        </div>
      )}

      <section className="summary-grid">
        <div className="summary-card">
          <div className="summary-label">Total outstanding</div>
          <div className="summary-value">{money(totalOutstanding)}</div>
          <div className="summary-hint">Unpaid shares across all bills</div>
        </div>
        <div className="summary-card">
          <div className="summary-label">Shares settled</div>
          <div className="summary-value">
            {paidShareCount}/{shareCount}
          </div>
          <div className="summary-hint">Payments recorded successfully</div>
        </div>
      </section>

      <div className="workspace">
        <section className="stack">
          <div className="panel">
            <h2>{home ? 'Your home' : 'Create a home'}</h2>
            <p className="panel-description">
              {home
                ? `Managing expenses for ${home.name}.`
                : 'Start by creating a shared space for your household.'}
            </p>

            {!home && (
              <form onSubmit={createHome}>
                <div className="field">
                  <label htmlFor="homeName">Home name</label>
                  <input
                    id="homeName"
                    value={homeName}
                    onChange={(event) => setHomeName(event.target.value)}
                    placeholder="e.g. Green Villa"
                    required
                    maxLength={100}
                  />
                </div>
                <button type="submit" className="button" disabled={creatingHome}>
                  {creatingHome ? 'Creating…' : '＋ Create home'}
                </button>
              </form>
            )}

            {home && (
              <>
                <div className="section-heading">
                  <h2>House members</h2>
                  <span className="count-pill">{members.length} members</span>
                </div>
                <form onSubmit={addMember}>
                  <div className="form-row">
                    <div className="field">
                      <label htmlFor="memberName">Member name</label>
                      <input
                        id="memberName"
                        value={memberName}
                        onChange={(event) => setMemberName(event.target.value)}
                        placeholder="Add a person"
                        required
                        maxLength={100}
                      />
                    </div>
                    <button className="button" disabled={creatingMember} type="submit">
                      {creatingMember ? 'Adding…' : '＋ Add'}
                    </button>
                  </div>
                </form>

                {members.length > 0 ? (
                  <div className="member-list">
                    {members.map((member) => (
                      <span className="member-chip" key={member.id}>
                        <span className="member-dot" />
                        {member.name}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="empty-state">
                    <div className="empty-icon">♧</div>
                    Add the people who share expenses in this home.
                  </div>
                )}
              </>
            )}
          </div>

          {home && (
            <div className="panel">
              <h2>Add a bill</h2>
              <p className="panel-description">
                The total will be split equally among all home members.
              </p>
              <form onSubmit={createBill}>
                <div className="field">
                  <label htmlFor="billTitle">Bill title</label>
                  <input
                    id="billTitle"
                    value={billTitle}
                    onChange={(event) => setBillTitle(event.target.value)}
                    placeholder="e.g. Monthly electricity"
                    required
                    maxLength={120}
                  />
                </div>
                <div className="field">
                  <label htmlFor="billAmount">Total amount (₹)</label>
                  <input
                    id="billAmount"
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={billAmount}
                    onChange={(event) => setBillAmount(event.target.value)}
                    placeholder="e.g. 2450.00"
                    required
                  />
                </div>
                <button
                  type="submit"
                  className="button"
                  disabled={creatingBill || members.length === 0}
                >
                  {creatingBill ? 'Splitting bill…' : '＋ Create and split bill'}
                </button>
                {members.length === 0 && (
                  <p className="panel-description">
                    Add at least one member before creating a bill.
                  </p>
                )}
              </form>
            </div>
          )}
        </section>

        <section className="panel">
          <div className="section-heading" style={{ marginTop: 0 }}>
            <h2>Recent bills</h2>
            <span className="count-pill">{bills.length} bills</span>
          </div>
          <p className="panel-description">Track each person's share and payment status.</p>

          {loading && <p className="loading">Loading your home data…</p>}

          {!loading && bills.length === 0 && (
            <div className="empty-state">
              <div className="empty-icon">▤</div>
              <div>No bills yet</div>
              Your household bills will appear here after you create one.
            </div>
          )}

          {bills.map((bill) => (
            <article className="bill-card" key={bill.id}>
              <div className="bill-top">
                <div>
                  <div className="bill-title">{bill.title}</div>
                  <div className="bill-subtitle">{bill.shares.length} shares</div>
                </div>
                <div className="bill-amount">{money(bill.totalCents)}</div>
              </div>

              {bill.shares.map((share) => {
                const member = members.find((item) => item.id === share.memberId)
                const isPaying = payingShare === share.id

                return (
                  <div className="share-row" key={share.id}>
                    <div className="share-person">
                      <div className="avatar">
                        {(member?.name ?? '?').slice(0, 1).toUpperCase()}
                      </div>
                      <div>
                        <div className="share-name">{member?.name ?? 'Home member'}</div>
                        <div className="share-status">
                          {share.paidAt ? 'Payment completed' : 'Payment pending'}
                        </div>
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div className="share-name">{money(share.amountCents)}</div>
                      {share.paidAt ? (
                        <span className="paid-label">✓ Paid</span>
                      ) : (
                        <button
                          type="button"
                          className="button button-small"
                          disabled={isPaying}
                          onClick={() => void payShare(bill.id, share.id)}
                        >
                          {isPaying ? 'Saving…' : 'Mark paid'}
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </article>
          ))}

          <div className="section-heading">
            <h2>Outstanding balances</h2>
          </div>
          {balances.length === 0 ? (
            <div className="empty-state">Add home members to see their balances.</div>
          ) : (
            balances.map((balance) => (
              <div className="share-row" key={balance.memberId}>
                <div className="share-person">
                  <div className="avatar">{balance.name.slice(0, 1).toUpperCase()}</div>
                  <div className="share-name">{balance.name}</div>
                </div>
                <div className="share-name">{money(balance.outstandingCents)}</div>
              </div>
            ))
          )}
        </section>
      </div>

      <footer className="footer">Built for shared homes · Every amount tracked in paise</footer>
    </main>
  )
}
