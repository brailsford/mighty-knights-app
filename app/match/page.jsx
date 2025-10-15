'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { supabaseBrowser } from '../../lib/supabase-browser'

const fmt = (ms) => {
  const s = Math.floor(ms / 1000)
  const mm = Math.floor(s / 60)
  const ss = s % 60
  return `${mm.toString().padStart(2,'0')}:${ss.toString().padStart(2,'0')}`
}

export default function MatchConsole() {
  const sb = supabaseBrowser()

  // Match config
  const [opponent, setOpponent] = useState('Opposition U9')
  const [halfLengthMin, setHalfLengthMin] = useState(10)
  const [maxOnField, setMaxOnField] = useState(8)

  // UX state
  const [dark, setDark] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [matchMs, setMatchMs] = useState(0)
  const lastTickRef = useRef(null)
  const halftimeMs = halfLengthMin * 60 * 1000

  // Data
  const [matchId, setMatchId] = useState(null)
  const [players, setPlayers] = useState([]) // [{id, display_name, initials, shirt_number}]
  const [intervals, setIntervals] = useState([])
  const [events, setEvents] = useState([])

  // Starter picker
  const [needsStarters, setNeedsStarters] = useState(false)
  const [starterIds, setStarterIds] = useState([])

  // Selection for rotation
  const [selectedBenchIds, setSelectedBenchIds] = useState([])
  const [selectedOnIds, setSelectedOnIds] = useState([])
  const [noteDraft, setNoteDraft] = useState('')

  // --- Clock loop (local authority for now) ---
  useEffect(() => {
    if (!isRunning) { lastTickRef.current = null; return }
    let raf = 0
    const loop = () => {
      const t = performance.now()
      if (lastTickRef.current == null) lastTickRef.current = t
      const dt = t - lastTickRef.current
      lastTickRef.current = t
      setMatchMs(m => m + dt)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [isRunning])

  // Load roster (named players) once
  useEffect(() => {
    const loadPlayers = async () => {
      const { data, error } = await sb
        .from('player')
        .select('id, display_name, initials, shirt_number, ext_id')
        .order('shirt_number', { nullsFirst: true })
      if (error) { console.error(error); return }
      const normalized = (data ?? []).map(p => ({
        id: p.id,
        name: p.display_name?.trim() || p.initials?.trim() || p.ext_id || 'Player',
        shirt: p.shirt_number ?? null,
      }))
      setPlayers(normalized)
    }
    loadPlayers()
  }, [])

  // Ensure a match row exists
  useEffect(() => {
    const boot = async () => {
      let mid = localStorage.getItem('mk_match_id')
      if (!mid) {
        const { data, error } = await sb.from('match').insert({
          opponent,
          half_length_minutes: halfLengthMin,
          max_on_field: maxOnField
        }).select('id').single()
        if (error) { console.error('create match', error); return }
        mid = data.id
        localStorage.setItem('mk_match_id', mid)
      }
      setMatchId(mid)
    }
    boot()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load state from DB + subscribe
  useEffect(() => {
    if (!matchId) return
    const refresh = async () => {
      const [{ data: pis }, { data: evs }] = await Promise.all([
        sb.from('playing_interval').select('*').eq('match_id', matchId).order('start_ms'),
        sb.from('event').select('*').eq('match_id', matchId).order('at_ms'),
      ])
      setIntervals((pis ?? []).map(r => ({ playerId: r.player_id, startMs: r.start_ms, endMs: r.end_ms ?? null })))
      setEvents((evs ?? []).map(e => ({ type: e.kind === 'SUB' ? 'SUB_BATCH' : e.kind, atMs: e.at_ms, playerId: e.player_id ?? undefined, note: e.note ?? undefined })))
      setNeedsStarters((pis ?? []).length === 0) // show picker if no starters persisted yet
    }
    const channel = sb
      .channel(`match:${matchId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'playing_interval', filter: `match_id=eq.${matchId}` }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'event', filter: `match_id=eq.${matchId}` }, refresh)
      .subscribe()
    refresh()
    return () => { sb.removeChannel(channel) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchId])

  // Helpers
  const isOnField = (pid) => intervals.some(i => i.playerId === pid && i.endMs == null)
  const onField = useMemo(() => players.filter(p => isOnField(p.id)), [players, intervals])
  const bench = useMemo(() => players.filter(p => !isOnField(p.id)), [players, intervals])
  const minutesByPlayer = useMemo(() => {
    const map = new Map()
    for (const i of intervals) {
      const end = i.endMs ?? matchMs
      const dur = Math.max(0, end - i.startMs)
      map.set(i.playerId, (map.get(i.playerId) ?? 0) + dur)
    }
    return map
  }, [intervals, matchMs])

  const fullGameMs = halfLengthMin * 2 * 60 * 1000
  const fullTimeTargetMs = players.length > 0 ? (fullGameMs * maxOnField) / players.length : 0

  // Starter picker actions
  const toggleStarter = (pid) => {
    setStarterIds(ids => ids.includes(pid) ? ids.filter(x => x !== pid) : [...ids, pid])
  }
  const confirmStarters = async () => {
    const n = starterIds.length
    if (n !== maxOnField) return
    // persist as playing_interval rows at t=0
    const rows = starterIds.map(id => ({ match_id: matchId, player_id: id, start_ms: 0 }))
    const { error } = await sb.from('playing_interval').insert(rows)
    if (error) { console.error(error); return }
    setNeedsStarters(false)
  }

  // Substitutions
  const doBatchSub = async (pairs) => {
    for (const { offId } of pairs) {
      await sb.from('playing_interval').update({ end_ms: Math.floor(matchMs) })
        .eq('match_id', matchId).eq('player_id', offId).is('end_ms', null)
    }
    for (const { onId } of pairs) {
      await sb.from('playing_interval').insert({ match_id: matchId, player_id: onId, start_ms: Math.floor(matchMs) })
    }
    await sb.from('event').insert({ match_id: matchId, kind: 'SUB', at_ms: Math.floor(matchMs), note: JSON.stringify(pairs) })
  }

  const quickAction = async (kind, playerId) => {
    await sb.from('event').insert({
      match_id: matchId,
      player_id: playerId ?? null,
      at_ms: Math.floor(matchMs),
      kind,
      note: kind === 'OTHER' ? (noteDraft || null) : null
    })
  }

  // UI helpers
  const suggestRotation = () => {
    const deficit = (pid) => fullTimeTargetMs - (minutesByPlayer.get(pid) ?? 0)
    const sOff = [...onField].sort((a,b) => (minutesByPlayer.get(b.id) ?? 0) - (minutesByPlayer.get(a.id) ?? 0))
    const sOn  = [...bench].sort((a,b) => deficit(b.id) - deficit(a.id))
    const n = Math.min(sOff.length, sOn.length, maxOnField)
    setSelectedOnIds(sOff.slice(0,n).map(p=>p.id))
    setSelectedBenchIds(sOn.slice(0,n).map(p=>p.id))
  }
  const confirmBatch = async () => {
    const n = Math.min(selectedBenchIds.length, selectedOnIds.length)
    const pairs = Array.from({length:n}, (_,i)=>({ onId: selectedBenchIds[i], offId: selectedOnIds[i] }))
    // local
    setIntervals(cur => {
      let u = [...cur]
      for (const {offId,onId} of pairs) {
        const idx = u.findIndex(it => it.playerId === offId && it.endMs == null)
        if (idx >= 0) u[idx] = { ...u[idx], endMs: matchMs }
        u.push({ playerId: onId, startMs: matchMs })
      }
      return u
    })
    setSelectedBenchIds([]); setSelectedOnIds([])
    // persist
    await doBatchSub(pairs)
  }

  return (
    <div className={dark ? 'dark' : ''}>
      <div className="space-y-4">
        {/* Header */}
        <div className="mb-2 flex items-center justify-between">
          <div>
            <div className="text-xl font-bold">Mighty Knights — Match Console</div>
            <div className="text-xs text-gray-500">vs {opponent} • {halfLengthMin}′ halves • {maxOnField}-a-side</div>
            {matchId && <div className="text-[10px] text-gray-400">Match ID: {matchId.slice(0,8)}…</div>}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={()=>setDark(d=>!d)} className="rounded-xl border px-3 py-2 text-sm shadow">{dark?'Light':'Dark'} mode</button>
          </div>
        </div>

        {/* Settings */}
        <div className="rounded-3xl border p-4 shadow grid grid-cols-1 gap-4 md:grid-cols-3">
          <label className="block text-sm">Team size (a-side)
            <select value={maxOnField} onChange={(e)=>setMaxOnField(parseInt(e.target.value))} className="mt-1 w-full rounded-xl border px-3 py-2">
              {[6,7,8,9,10].map(v=> <option key={v} value={v}>{v} a-side</option>)}
            </select>
          </label>
          <label className="block text-sm">Half length
            <select value={halfLengthMin} onChange={(e)=>setHalfLengthMin(parseInt(e.target.value))} className="mt-1 w-full rounded-xl border px-3 py-2">
              {Array.from({length:8},(_,i)=>i+8).map(v=> <option key={v} value={v}>{v} minutes</option>)}
            </select>
          </label>
          <label className="block text-sm">Opponent
            <input value={opponent} onChange={(e)=>setOpponent(e.target.value)} className="mt-1 w-full rounded-xl border px-3 py-2"/>
          </label>
        </div>

        {/* Starter picker overlay (when needed) */}
        {needsStarters && (
          <div className="rounded-3xl border p-4 shadow bg-amber-50">
            <div className="mb-2 text-sm font-semibold">Select your starting {maxOnField}</div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
              {players.map(p => {
                const selected = starterIds.includes(p.id)
                return (
                  <button key={p.id}
                    onClick={()=>toggleStarter(p.id)}
                    className={`rounded-xl border px-3 py-2 text-left ${selected?'ring-2 ring-blue-500 bg-white':'bg-white'}`}>
                    <div className="font-medium">{p.name}</div>
                    {p.shirt && <div className="text-xs text-gray-500">#{p.shirt}</div>}
                  </button>
                )
              })}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <button
                onClick={confirmStarters}
                disabled={starterIds.length !== maxOnField}
                className={`rounded-xl px-3 py-2 text-sm shadow ${starterIds.length===maxOnField?'bg-emerald-600 text-white':'bg-gray-100 text-gray-400'}`}>
                Set Starters ({starterIds.length}/{maxOnField})
              </button>
              <div className="text-xs text-gray-600">Pick exactly {maxOnField} to continue.</div>
            </div>
          </div>
        )}

        {/* Clock */}
        <div className="rounded-3xl border p-4 shadow flex items-center justify-between">
          <div>
            <div className="text-sm text-gray-500">Match Clock</div>
            <div className="text-6xl font-extrabold tabular-nums">{fmt(matchMs)}</div>
            <div className="text-xs text-gray-500">On field: {onField.length}/{maxOnField}</div>
          </div>
          <div className="flex gap-2">
            <button onClick={()=>setIsRunning(v=>!v)} className={`rounded-2xl px-4 py-3 text-white shadow ${isRunning?'bg-red-600':'bg-green-600'}`}>
              {isRunning?'Pause':'Start'}
            </button>
          </div>
        </div>

        {/* On Field & Bench */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="rounded-3xl border p-4 shadow lg:col-span-2">
            <h2 className="mb-2 text-lg font-semibold">On Field ({onField.length}/{maxOnField})</h2>
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
              {onField.map(p => {
                const played = minutesByPlayer.get(p.id) ?? 0
                return (
                  <li key={p.id} className="rounded-2xl border px-3 py-2">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-medium">{p.name}</div>
                        <div className="text-xs text-gray-500">⏱ {fmt(played)}</div>
                      </div>
                      <button
                        onClick={() => setSelectedOnIds(ids => ids.includes(p.id) ? ids.filter(x=>x!==p.id) : [...ids, p.id])}
                        className={`rounded-xl px-3 py-1 text-sm ${selectedOnIds.includes(p.id)?'bg-blue-600 text-white':'bg-gray-100'}`}
                      >
                        {selectedOnIds.includes(p.id)?'Selected':'Mark OFF'}
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>

          <div className="rounded-3xl border p-4 shadow">
            <h2 className="mb-2 text-lg font-semibold">Bench</h2>
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {bench.map(p => {
                const played = minutesByPlayer.get(p.id) ?? 0
                return (
                  <li key={p.id} className="rounded-2xl border px-3 py-2">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-medium">{p.name}</div>
                        <div className="text-xs text-gray-500">⏱ {fmt(played)}</div>
                      </div>
                      <button
                        onClick={() => setSelectedBenchIds(ids => ids.includes(p.id) ? ids.filter(x=>x!==p.id) : [...ids, p.id])}
                        className={`rounded-xl px-3 py-1 text-sm ${selectedBenchIds.includes(p.id)?'bg-blue-600 text-white':'bg-gray-100'}`}
                      >
                        {selectedBenchIds.includes(p.id)?'Selected':'Mark ON'}
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>

            <div className="mt-3 flex flex-wrap gap-2">
              <button onClick={suggestRotation} className="rounded-xl px-3 py-2 text-sm shadow bg-blue-50 text-blue-700 border border-blue-200">
                Suggest rotation (now)
              </button>
              <button
                onClick={confirmBatch}
                disabled={!selectedBenchIds.length || !selectedOnIds.length || selectedBenchIds.length !== selectedOnIds.length}
                className={`rounded-xl px-3 py-2 text-sm shadow ${
                  selectedBenchIds.length && selectedOnIds.length && selectedBenchIds.length === selectedOnIds.length
                    ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-400'
                }`}
              >
                Confirm batch ({Math.min(selectedBenchIds.length, selectedOnIds.length)})
              </button>
              <button onClick={()=>{ setSelectedBenchIds([]); setSelectedOnIds([]); }} className="rounded-xl border px-3 py-2 text-sm shadow">
                Clear
              </button>
            </div>
          </div>
        </div>

        {/* Quick actions */}
        <div className="rounded-3xl border p-4 shadow">
          <h3 className="mb-3 text-lg font-semibold">Quick Actions</h3>
          <div className="mb-3 grid grid-cols-3 gap-2">
            <button onClick={()=>quickAction('TRY')} className="rounded-xl px-3 py-2 text-sm shadow bg-emerald-600 text-white">Log Try (no player)</button>
            <button onClick={()=>quickAction('TACKLE')} className="rounded-xl px-3 py-2 text-sm shadow bg-indigo-600 text-white">Log Tackle (no player)</button>
            <button onClick={()=>quickAction('OTHER')} className="rounded-xl px-3 py-2 text-sm shadow bg-gray-800 text-white">Other (note)</button>
          </div>
          <input value={noteDraft} onChange={(e)=>setNoteDraft(e.target.value)} placeholder="Optional note for Other" className="mb-3 w-full rounded-xl border px-3 py-2"/>
        </div>
      </div>
    </div>
  )
}
