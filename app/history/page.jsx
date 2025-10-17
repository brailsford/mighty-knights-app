'use client'
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabaseBrowser } from '../../lib/supabase-browser'

const fmtDate = (iso) => {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString([], { year:'2-digit', month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit' })
}
const fmtMins = (ms=0) => {
  const m = Math.round(ms/60000)
  return `${m} min`
}

export default function HistoryPage() {
  const sb = supabaseBrowser()
  const [teams, setTeams] = useState([])
  const [teamId, setTeamId] = useState(null)
  const [status, setStatus] = useState('all') // all | draft | live | final
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(true)
  const [matches, setMatches] = useState([])   // list of match rows
  const [eventsAgg, setEventsAgg] = useState(new Map())   // matchId -> {tries,tackles}
  const [minutesAgg, setMinutesAgg] = useState(new Map()) // matchId -> minutesMs

  // Load squads
  useEffect(() => { (async () => {
    const { data } = await sb.from('team').select('id,name,squad').order('squad')
    setTeams(data||[])
    setTeamId(data?.[0]?.id || null)
  })() }, [])

  // Load matches for squad (filtered)
  useEffect(() => {
    const load = async () => {
      if (!teamId) return
      setLoading(true)

      let mQuery = sb.from('match')
        .select('id, team_id, opponent, status, started_at, completed_at, half_length_minutes, max_on_field')
        .eq('team_id', teamId)
        .order('started_at', { ascending: false })
        .limit(50)

      if (status !== 'all') mQuery = mQuery.eq('status', status)
      if (q.trim()) mQuery = mQuery.ilike('opponent', `%${q.trim()}%`)

      const { data: ms } = await mQuery
      setMatches(ms || [])

      // Aggregate events (tries/tackles) grouped by match
      const ids = (ms||[]).map(m => m.id)
      if (!ids.length) { setEventsAgg(new Map()); setMinutesAgg(new Map()); setLoading(false); return }

      const { data: evs } = await sb
        .from('event')
        .select('match_id, kind')
        .in('match_id', ids)

      const eventsMap = new Map()
      for (const e of (evs||[])) {
        const rec = eventsMap.get(e.match_id) || { tries:0, tackles:0 }
        if (e.kind === 'TRY') rec.tries++
        if (e.kind === 'TACKLE') rec.tackles++
        eventsMap.set(e.match_id, rec)
      }
      setEventsAgg(eventsMap)

      // Aggregate minutes: fetch intervals once and sum (capping open intervals at completed_at if present)
      const { data: ints } = await sb
        .from('playing_interval')
        .select('match_id, start_ms, end_ms')
        .in('match_id', ids)

      const endMap = new Map(ms.map(m => [m.id, m.completed_at ? new Date(m.completed_at).getTime() - (m.started_at ? new Date(m.started_at).getTime() : 0) : null]))
      const minMap = new Map()
      const zero = 0
      for (const i of (ints||[])) {
        const endMs = (i.end_ms ?? endMap.get(i.match_id) ?? i.start_ms) // cap at match length if final, else 0 length when missing
        const dur = Math.max(zero, endMs - i.start_ms)
        minMap.set(i.match_id, (minMap.get(i.match_id) ?? 0) + dur)
      }
      setMinutesAgg(minMap)
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, status, q])

  const duplicate = async (m) => {
    const sb = supabaseBrowser()
    const { data, error } = await sb.from('match').insert({
      team_id: m.team_id,
      opponent: m.opponent,
      half_length_minutes: m.half_length_minutes,
      max_on_field: m.max_on_field,
      status: 'draft',
    }).select('id').single()
    if (!error && data?.id) {
      localStorage.setItem('mk_match_id', data.id)
      window.location.href = '/match'
    }
  }

  const reopen = async (m) => {
    if (!confirm('Reopen this match for editing?')) return
    const { error } = await sb.from('match').update({ status: 'draft' }).eq('id', m.id)
    if (!error) {
      setMatches(cur => cur.map(x => x.id === m.id ? { ...x, status:'draft' } : x))
    }
  }

  const list = useMemo(() => matches, [matches])

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight">Match History</h1>
          <p className="text-sm text-gray-500 truncate">Recent games for your selected squad. Tap a card to view summary.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <select value={teamId||''} onChange={e=>setTeamId(e.target.value)} className="field field-dark w-[calc(50%-0.25rem)] sm:w-auto">
            {teams.map(t => <option key={t.id} value={t.id}>{t.name} — {t.squad.toUpperCase()}</option>)}
          </select>
          <select value={status} onChange={e=>setStatus(e.target.value)} className="field field-dark w-[calc(50%-0.25rem)] sm:w-auto">
            <option value="all">All statuses</option>
            <option value="final">Final</option>
            <option value="live">Live</option>
            <option value="draft">Draft</option>
          </select>
          <input className="field field-dark w-full sm:w-60" placeholder="Search opponent…" value={q} onChange={e=>setQ(e.target.value)} />
        </div>
      </div>

      <div className="card card-narrow">
        {loading ? (
          <div className="text-sm text-gray-500">Loading…</div>
        ) : list.length === 0 ? (
          <div className="text-sm text-gray-500">No matches yet.</div>
        ) : (
          <ul className="grid grid-cols-1 gap-3">
            {list.map(m => {
              const ev = eventsAgg.get(m.id) || { tries:0, tackles:0 }
              const mins = minutesAgg.get(m.id) || 0
              const badge = m.status === 'final' ? 'bg-green-50 text-green-700'
                          : m.status === 'live' ? 'bg-yellow-50 text-yellow-800'
                          : 'bg-gray-100 text-gray-700'
              return (
                <li key={m.id} className="rounded-3xl border border-black/5 dark:border-white/10 bg-[var(--surface)] p-4 shadow-soft">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <Link href={`/summary/${m.id}`} className="block font-semibold hover:underline truncate">
                        {m.opponent || 'Opponent'} • {m.max_on_field}-a-side • {m.half_length_minutes}′ halves
                      </Link>
                      <div className="text-xs text-gray-500">
                        {fmtDate(m.started_at)} {m.completed_at ? '→ ' + fmtDate(m.completed_at) : ''}
                      </div>
                    </div>
                    <span className={`chip ${badge}`}>{m.status}</span>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-4 text-sm">
                    <div>⏱ <span className="font-medium tabular-nums">{fmtMins(mins)}</span></div>
                    <div>Tries <span className="font-semibold">{ev.tries}</span></div>
                    <div>Tackles <span className="font-semibold">{ev.tackles}</span></div>
                  </div>

                  <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                    <Link href={`/summary/${m.id}`} className="btn btn-outline w-full sm:w-auto">Open summary</Link>
                    {m.status === 'final' ? (
                      <button onClick={()=>reopen(m)} className="btn btn-ghost w-full sm:w-auto">Reopen</button>
                    ) : null}
                    <button onClick={()=>duplicate(m)} className="btn btn-primary w-full sm:w-auto">Duplicate as new match</button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
