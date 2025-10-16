'use client'
import { useEffect, useMemo, useState } from 'react'
import { supabaseBrowser } from '../../../lib/supabase-browser'
import Link from 'next/link'

const fmt = (ms) => {
  const s = Math.floor(ms / 1000); const mm = Math.floor(s / 60); const ss = s % 60
  return `${mm.toString().padStart(2,'0')}:${ss.toString().padStart(2,'0')}`
}

export default function SummaryPage({ params }) {
  const matchId = params.id
  const sb = supabaseBrowser()

  const [match, setMatch] = useState(null)
  const [players, setPlayers] = useState([])
  const [intervals, setIntervals] = useState([])
  const [events, setEvents] = useState([])

  useEffect(() => {
    (async () => {
      const [{ data: m }, { data: pis }, { data: evs }] = await Promise.all([
        sb.from('match').select('id,team_id,opponent,half_length_minutes,max_on_field,status,started_at,completed_at').eq('id', matchId).single(),
        sb.from('playing_interval').select('*').eq('match_id', matchId),
        sb.from('event').select('*').eq('match_id', matchId).order('at_ms')
      ])
      setMatch(m); setIntervals(pis||[]); setEvents(evs||[])
      if (m?.team_id) {
        const { data: ps } = await sb.from('player').select('id,display_name,initials,shirt_number').eq('team_id', m.team_id)
        setPlayers((ps||[]).map(p => ({ id: p.id, name: p.display_name?.trim() || p.initials || 'Player', shirt: p.shirt_number ?? null })))
      }
    })()
  }, [matchId])

  const minutesByPlayer = useMemo(() => {
    const map = new Map()
    for (const i of intervals) {
      const end = i.end_ms ?? i.start_ms
      const dur = Math.max(0, end - i.start_ms)
      map.set(i.player_id, (map.get(i.player_id) ?? 0) + dur)
    }
    return map
  }, [intervals])

  const counts = useMemo(() => {
    const map = new Map()
    for (const e of events) {
      if (!['TRY','TACKLE','OTHER'].includes(e.kind)) continue
      const pid = e.player_id || 'NO_PLAYER'
      const m = map.get(pid) || { tries:0, tackles:0, other:0 }
      if (e.kind === 'TRY') m.tries++
      if (e.kind === 'TACKLE') m.tackles++
      if (e.kind === 'OTHER') m.other++
      map.set(pid, m)
    }
    return map
  }, [events])

  const rows = players.map(p => ({
    id: p.id, name: p.name, shirt: p.shirt,
    minutes: minutesByPlayer.get(p.id) ?? 0,
    tries: (counts.get(p.id)||{}).tries || 0,
    tackles: (counts.get(p.id)||{}).tackles || 0,
    other: (counts.get(p.id)||{}).other || 0
  })).sort((a,b)=> (b.minutes - a.minutes))

  const teamTotals = rows.reduce((acc,r)=>({
    minutes: acc.minutes + r.minutes, tries: acc.tries + r.tries, tackles: acc.tackles + r.tackles, other: acc.other + r.other
  }), { minutes:0, tries:0, tackles:0, other:0 })

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Post-match Summary</h1>
        <Link href="/match" className="rounded-xl border px-3 py-2 text-sm shadow">Back to Match Console</Link>
      </div>

      {match && (
        <div className="rounded-3xl border p-4 shadow grid grid-cols-1 gap-2 sm:grid-cols-4">
          <div><div className="text-xs text-gray-500">Opponent</div><div className="font-medium">{match.opponent}</div></div>
          <div><div className="text-xs text-gray-500">Status</div><div className="font-medium">{match.status}</div></div>
          <div><div className="text-xs text-gray-500">Half length</div><div className="font-medium">{match.half_length_minutes}′</div></div>
          <div><div className="text-xs text-gray-500">A-side</div><div className="font-medium">{match.max_on_field}</div></div>
        </div>
      )}

      <div className="rounded-3xl border p-4 shadow">
        <h2 className="mb-2 text-lg font-semibold">Team totals</h2>
        <div className="flex gap-6 text-sm">
          <div>Minutes: <span className="font-medium">{fmt(teamTotals.minutes)}</span></div>
          <div>Tries: <span className="font-medium">{teamTotals.tries}</span></div>
          <div>Tackles: <span className="font-medium">{teamTotals.tackles}</span></div>
          <div>Other: <span className="font-medium">{teamTotals.other}</span></div>
        </div>
      </div>

      <div className="rounded-3xl border p-4 shadow">
        <h2 className="mb-3 text-lg font-semibold">Players</h2>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
          {rows.map(r => (
            <div key={r.id} className="rounded-2xl border p-3">
              <div className="flex items-center justify-between">
                <div className="font-medium">{r.name} {r.shirt ? `#${r.shirt}` : ''}</div>
                <div className="text-xs text-gray-500">⏱ {fmt(r.minutes)}</div>
              </div>
              <div className="mt-2 flex gap-3 text-sm">
                <div>Tries <span className="font-semibold">{r.tries}</span></div>
                <div>Tackles <span className="font-semibold">{r.tackles}</span></div>
                <div>Other <span className="font-semibold">{r.other}</span></div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-3xl border p-4 shadow">
        <h2 className="mb-2 text-lg font-semibold">Event timeline</h2>
        <ul className="space-y-2 max-h-96 overflow-auto pr-1">
          {events.map((e,i)=>(
            <li key={i} className="rounded-xl border px-3 py-2 text-sm flex items-center justify-between">
              <span>
                <span className="inline-block rounded bg-gray-100 px-2 py-0.5 text-gray-700 mr-2 text-xs">{e.kind}</span>
                {players.find(p=>p.id===e.player_id)?.name || '(no player)'} {e.note ? `— ${e.note}` : ''}
              </span>
              <span className="tabular-nums text-xs text-gray-500">{fmt(e.at_ms||0)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
