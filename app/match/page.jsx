'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabaseBrowser } from '../../lib/supabase-browser'

const fmt = (ms) => {
  const s = Math.floor(ms / 1000); const mm = Math.floor(s / 60); const ss = s % 60
  return `${mm.toString().padStart(2,'0')}:${ss.toString().padStart(2,'0')}`
}

export default function MatchConsole() {
  const sb = supabaseBrowser()
  const router = useRouter()

  // Match config
  const [teams, setTeams] = useState([])
  const [teamId, setTeamId] = useState(null)
  const [opponent, setOpponent] = useState('Opposition U9')
  const [halfLengthMin, setHalfLengthMin] = useState(10)
  const [maxOnField, setMaxOnField] = useState(8)

  // UX state
  const [dark, setDark] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [matchMs, setMatchMs] = useState(0)
  const lastTickRef = useRef(null)

  // Data
  const [matchId, setMatchId] = useState(null)
  const [matchStatus, setMatchStatus] = useState('draft') // draft | live | final
  const [players, setPlayers] = useState([]) // filtered by squad
  const [intervals, setIntervals] = useState([])
  const [events, setEvents] = useState([])

  // Starters
  const [needsStarters, setNeedsStarters] = useState(false)
  const [starterIds, setStarterIds] = useState([])

  // Selection for rotation
  const [selectedBenchIds, setSelectedBenchIds] = useState([])
  const [selectedOnIds, setSelectedOnIds] = useState([])
  const [noteDraft, setNoteDraft] = useState('')

  // Clock loop (local for now)
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

  // Load teams, choose default
  useEffect(() => { (async () => {
    const { data } = await sb.from('team').select('id,name,squad').order('squad')
    setTeams(data||[])
    setTeamId(data?.[0]?.id || null)
  })() }, [])

  // Load players for selected squad
  useEffect(() => { (async () => {
    if (!teamId) return
    const { data } = await sb
      .from('player')
      .select('id, display_name, initials, shirt_number')
      .eq('team_id', teamId)
      .order('shirt_number', { nullsFirst: true })
    const normalized = (data||[]).map(p => ({ id: p.id, name: p.display_name?.trim() || p.initials || 'Player', shirt: p.shirt_number ?? null }))
    setPlayers(normalized)
  })() }, [teamId])

  // Create or load a match for this squad
  useEffect(() => {
    const boot = async () => {
      if (!teamId) return
      let mid = localStorage.getItem('mk_match_id')
      if (mid) {
        const { data: m } = await sb.from('match').select('id,team_id,status,half_length_minutes,max_on_field,opponent').eq('id', mid).maybeSingle()
        if (m && m.team_id === teamId) {
          setMatchId(m.id); setMatchStatus(m.status)
          setHalfLengthMin(m.half_length_minutes || halfLengthMin)
          setMaxOnField(m.max_on_field || maxOnField)
          setOpponent(m.opponent || opponent)
          return
        }
      }
      // create a fresh match for this team
      const { data, error } = await sb.from('match').insert({
        team_id: teamId, opponent, half_length_minutes: halfLengthMin, max_on_field: maxOnField, status: 'draft'
      }).select('id,status').single()
      if (!error && data) {
        localStorage.setItem('mk_match_id', data.id)
        setMatchId(data.id); setMatchStatus(data.status)
      }
    }
    boot()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId])

  // Pull DB state + subscribe
  useEffect(() => {
    if (!matchId) return
    const refresh = async () => {
      const [{ data: m }, { data: pis }, { data: evs }] = await Promise.all([
        sb.from('match').select('status,half_length_minutes,max_on_field,opponent').eq('id', matchId).maybeSingle(),
        sb.from('playing_interval').select('*').eq('match_id', matchId).order('start_ms'),
        sb.from('event').select('*').eq('match_id', matchId).order('at_ms')
      ])
      if (m) {
        setMatchStatus(m.status)
        setHalfLengthMin(m.half_length_minutes || halfLengthMin)
        setMaxOnField(m.max_on_field || maxOnField)
        setOpponent(m.opponent || opponent)
      }
      setIntervals((pis||[]).map(r => ({ playerId: r.player_id, startMs: r.start_ms, endMs: r.end_ms ?? null })))
      setEvents((evs||[]).map(e => ({ type: e.kind === 'SUB' ? 'SUB_BATCH' : e.kind, atMs: e.at_ms, playerId: e.player_id ?? undefined, note: e.note ?? undefined })))
      setNeedsStarters((pis||[]).length === 0 && matchStatus !== 'final')
    }
    const channel = sb
      .channel(`match:${matchId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'playing_interval', filter: `match_id=eq.${matchId}` }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'match', filter: `id=eq.${matchId}` }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'event', filter: `match_id=eq.${matchId}` }, refresh)
      .subscribe()
    refresh()
    return () => { sb.removeChannel(channel) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchId])

  // Derived
  const isLocked = matchStatus !== 'draft'    // lock settings after kickoff
  const isFinal  = matchStatus === 'final'
  const isOnField = (pid) => intervals.some(i => i.playerId === pid && i.endMs == null)
  const onField = useMemo(() => players.filter(p => isOnField(p.id)), [players, intervals])
  const bench   = useMemo(() => players.filter(p => !isOnField(p.id)), [players, intervals])

  const minutesByPlayer = useMemo(() => {
    const map = new Map()
    for (const i of intervals) {
      const end = i.endMs ?? matchMs
      const dur = Math.max(0, end - i.startMs)
      map.set(i.playerId, (map.get(i.playerId) ?? 0) + dur)
    }
    return map
  }, [intervals, matchMs])

  // Starter picker controls
  const toggleStarter = (pid) => setStarterIds(ids => ids.includes(pid) ? ids.filter(x=>x!==pid) : [...ids, pid])
  const confirmStarters = async () => {
    if (starterIds.length !== maxOnField) return
    // Persist at t=0
    const rows = starterIds.map(id => ({ match_id: matchId, player_id: id, start_ms: 0 }))
    const { error } = await sb.from('playing_interval').insert(rows)
    if (!error) {
      // Optimistic local state → shows instantly (no refresh required)
      setIntervals(rows.map(r => ({ playerId: r.player_id, startMs: 0, endMs: null })))
      setNeedsStarters(false)
      // Kickoff: lock settings, set status live
      await sb.from('match').update({ status: 'live', started_at: new Date().toISOString() }).eq('id', matchId)
      setMatchStatus('live')
    }
  }

  // Substitutions
  const confirmBatch = async () => {
    const n = Math.min(selectedBenchIds.length, selectedOnIds.length)
    const pairs = Array.from({length:n}, (_,i)=>({ onId: selectedBenchIds[i], offId: selectedOnIds[i] }))
    // local UI
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
    for (const { offId } of pairs) {
      await sb.from('playing_interval').update({ end_ms: Math.floor(matchMs) }).eq('match_id', matchId).eq('player_id', offId).is('end_ms', null)
    }
    for (const { onId } of pairs) {
      await sb.from('playing_interval').insert({ match_id: matchId, player_id: onId, start_ms: Math.floor(matchMs) })
    }
    await sb.from('event').insert({ match_id: matchId, kind: 'SUB', at_ms: Math.floor(matchMs), note: JSON.stringify(pairs) })
  }

  // Remove (no replacement)
  const removeNoReplace = async (pid) => {
    // local
    setIntervals(cur => {
      const idx = cur.findIndex(it => it.playerId === pid && it.endMs == null)
      if (idx >= 0) { const u=[...cur]; u[idx]={...u[idx], endMs: matchMs}; return u }
      return cur
    })
    // persist
    await sb.from('playing_interval').update({ end_ms: Math.floor(matchMs) }).eq('match_id', matchId).eq('player_id', pid).is('end_ms', null)
  }

  // Quick actions
  const quickAction = async (kind, playerId) => {
    await sb.from('event').insert({
      match_id: matchId, player_id: playerId ?? null, at_ms: Math.floor(matchMs), kind, note: null
    })
  }

  // Suggest rotation
  const suggestRotation = () => {
    const fullGameMs = halfLengthMin * 2 * 60 * 1000
    const fullTarget = players.length ? (fullGameMs * maxOnField) / players.length : 0
    const deficit = (pid) => fullTarget - (minutesByPlayer.get(pid) ?? 0)
    const sOff = [...onField].sort((a,b) => (minutesByPlayer.get(b.id) ?? 0) - (minutesByPlayer.get(a.id) ?? 0))
    const sOn  = [...bench].sort((a,b) => deficit(b.id) - deficit(a.id))
    const n = Math.min(sOff.length, sOn.length, maxOnField)
    setSelectedOnIds(sOff.slice(0,n).map(p=>p.id))
    setSelectedBenchIds(sOn.slice(0,n).map(p=>p.id))
  }

  // Reset setup (soft reset)
  const resetMatch = async () => {
    if (!confirm('Reset this match setup? This will clear starters, intervals and events.')) return
    await sb.from('playing_interval').delete().eq('match_id', matchId)
    await sb.from('event').delete().eq('match_id', matchId)
    await sb.from('match').update({ status: 'draft', started_at: null }).eq('id', matchId)
    setIntervals([]); setEvents([]); setMatchStatus('draft'); setNeedsStarters(true); setStarterIds([]); setIsRunning(false); setMatchMs(0)
  }

  // End game → Commit & go to summary
  const endGame = async () => {
    if (!confirm('End game and commit stats?')) return
    await sb.from('match').update({ status: 'final', completed_at: new Date().toISOString() }).eq('id', matchId)
    setMatchStatus('final')
    router.push(`/summary/${matchId}`)
  }

  // UI bits
  const controlDisabled = isFinal || needsStarters
  const settingsDisabled = isLocked

  return (
    <div className={dark ? 'dark' : ''}>
      <div className="space-y-4">
        {/* Header */}
        <div className="mb-2 flex items-center justify-between">
          <div>
            <div className="text-xl font-bold">Mighty Knights — Match Console</div>
            <div className="text-xs text-gray-500">
              {teams.find(t=>t.id===teamId)?.squad?.toUpperCase()} • vs {opponent} • {halfLengthMin}′ halves • {maxOnField}-a-side
            </div>
            {matchId && <div className="text-[10px] text-gray-400">Match ID: {matchId.slice(0,8)}… • Status: {matchStatus}</div>}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={()=>setDark(d=>!d)} className="rounded-xl border px-3 py-2 text-sm shadow">{dark?'Light':'Dark'} mode</button>
          </div>
        </div>

        {/* Settings (locked after kickoff) */}
        <div className="rounded-3xl border p-4 shadow grid grid-cols-1 gap-4 md:grid-cols-4">
          <label className="block text-sm">Squad
            <select value={teamId||''} onChange={(e)=>setTeamId(e.target.value)} className="mt-1 w-full rounded-xl border px-3 py-2" disabled={settingsDisabled}>
              {teams.map(t => <option key={t.id} value={t.id}>{t.name} — {t.squad.toUpperCase()}</option>)}
            </select>
          </label>
          <label className="block text-sm">Team size (a-side)
            <select value={maxOnField} onChange={(e)=>setMaxOnField(parseInt(e.target.value))} className="mt-1 w-full rounded-xl border px-3 py-2" disabled={settingsDisabled}>
              {[6,7,8,9,10].map(v=> <option key={v} value={v}>{v} a-side</option>)}
            </select>
          </label>
          <label className="block text-sm">Half length
            <select value={halfLengthMin} onChange={(e)=>setHalfLengthMin(parseInt(e.target.value))} className="mt-1 w-full rounded-xl border px-3 py-2" disabled={settingsDisabled}>
              {Array.from({length:8},(_,i)=>i+8).map(v=> <option key={v} value={v}>{v} minutes</option>)}
            </select>
          </label>
          <label className="block text-sm">Opponent
            <input value={opponent} onChange={(e)=>setOpponent(e.target.value)} className="mt-1 w-full rounded-xl border px-3 py-2" disabled={settingsDisabled}/>
          </label>
        </div>

        {/* Starter picker */}
        {needsStarters && (
          <div className="rounded-3xl border p-4 shadow bg-amber-50">
            <div className="mb-2 text-sm font-semibold">Select your starting {maxOnField}</div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
              {players.map(p => {
                const selected = starterIds.includes(p.id)
                return (
                  <button key={p.id} onClick={()=>toggleStarter(p.id)}
                    className={`rounded-xl border px-3 py-2 text-left ${selected?'ring-2 ring-blue-500 bg-white':'bg-white'}`}>
                    <div className="font-medium">{p.name}</div>
                    {p.shirt && <div className="text-xs text-gray-500">#{p.shirt}</div>}
                  </button>
                )
              })}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <button onClick={confirmStarters} disabled={starterIds.length !== maxOnField}
                className={`rounded-xl px-3 py-2 text-sm shadow ${starterIds.length===maxOnField?'bg-emerald-600 text-white':'bg-gray-100 text-gray-400'}`}>
                Set Starters ({starterIds.length}/{maxOnField})
              </button>
              <div className="text-xs text-gray-600">Pick exactly {maxOnField} to continue.</div>
            </div>
          </div>
        )}

        {/* Clock & actions */}
        <div className="rounded-3xl border p-4 shadow flex items-center justify-between">
          <div>
            <div className="text-sm text-gray-500">Match Clock</div>
            <div className="text-6xl font-extrabold tabular-nums">{fmt(matchMs)}</div>
            <div className="text-xs text-gray-500">On field: {onField.length}/{maxOnField}</div>
          </div>
          <div className="flex gap-2">
            <button onClick={()=>setIsRunning(v=>!v)} disabled={controlDisabled}
              className={`rounded-2xl px-4 py-3 text-white shadow ${isRunning?'bg-red-600':'bg-green-600'} ${controlDisabled?'opacity-50':''}`}>
              {isRunning?'Pause':'Start'}
            </button>
            <button onClick={resetMatch} className="rounded-2xl px-4 py-3 border shadow" disabled={isFinal}>Reset</button>
            <button onClick={endGame} className="rounded-2xl px-4 py-3 bg-black text-white shadow" disabled={isFinal}>End game</button>
          </div>
        </div>

        {/* On Field & Bench */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="rounded-3xl border p-4 shadow lg:col-span-2">
            <h2 className="mb-2 text-lg font-semibold">On Field ({onField.length}/{maxOnField})</h2>
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
              {onField.map(p => {
                const played = minutesByPlayer.get(p.id) ?? 0
                const selected = selectedOnIds.includes(p.id)
                return (
                  <li key={p.id} className={`rounded-2xl border px-3 py-2 ${selected?'ring-2 ring-blue-500':''}`}>
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-medium">{p.name} {p.shirt ? `#${p.shirt}` : ''}</div>
                        <div className="text-xs text-gray-500">⏱ {fmt(played)}</div>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <div className="flex gap-1">
                          <button onClick={()=>setSelectedOnIds(ids=>ids.includes(p.id)?ids.filter(x=>x!==p.id):[...ids,p.id])}
                            className="rounded-xl px-3 py-1 text-sm bg-gray-100">{selected?'Selected':'Mark OFF'}</button>
                          <button onClick={()=>removeNoReplace(p.id)} className="rounded-xl px-3 py-1 text-sm bg-orange-100">Remove</button>
                        </div>
                        <div className="flex gap-1">
                          <button onClick={()=>quickAction('TRY', p.id)} className="rounded-lg bg-emerald-600 text-white px-2 py-1 text-[11px]">Try</button>
                          <button onClick={()=>quickAction('TACKLE', p.id)} className="rounded-lg bg-indigo-600 text-white px-2 py-1 text-[11px]">Tackle</button>
                          <button onClick={()=>quickAction('OTHER', p.id)} className="rounded-lg bg-gray-800 text-white px-2 py-1 text-[11px]">Other</button>
                        </div>
                      </div>
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
                const selected = selectedBenchIds.includes(p.id)
                return (
                  <li key={p.id} className={`rounded-2xl border px-3 py-2 ${selected?'ring-2 ring-blue-500':''}`}>
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-medium">{p.name} {p.shirt ? `#${p.shirt}` : ''}</div>
                        <div className="text-xs text-gray-500">⏱ {fmt(played)}</div>
                      </div>
                      <button onClick={()=>setSelectedBenchIds(ids=>ids.includes(p.id)?ids.filter(x=>x!==p.id):[...ids,p.id])}
                        className="rounded-xl px-3 py-1 text-sm bg-gray-100">{selected?'Selected':'Mark ON'}</button>
                    </div>
                  </li>
                )
              })}
            </ul>

            <div className="mt-3 flex flex-wrap gap-2">
              <button onClick={suggestRotation} className="rounded-xl px-3 py-2 text-sm shadow bg-blue-50 text-blue-700 border border-blue-200">
                Suggest rotation (now)
              </button>
              <button onClick={confirmBatch}
                disabled={!selectedBenchIds.length || !selectedOnIds.length || selectedBenchIds.length !== selectedOnIds.length}
                className={`rounded-xl px-3 py-2 text-sm shadow ${
                  selectedBenchIds.length && selectedOnIds.length && selectedBenchIds.length === selectedOnIds.length
                    ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-400'
                }`}>
                Confirm batch ({Math.min(selectedBenchIds.length, selectedOnIds.length)})
              </button>
              <button onClick={()=>{ setSelectedBenchIds([]); setSelectedOnIds([]) }} className="rounded-xl border px-3 py-2 text-sm shadow">
                Clear
              </button>
            </div>
          </div>
        </div>

        {/* Quick actions (no player) */}
        <div className="rounded-3xl border p-4 shadow">
          <h3 className="mb-3 text-lg font-semibold">Quick Actions</h3>
          <div className="mb-3 grid grid-cols-3 gap-2">
            <button onClick={()=>quickAction('TRY')} className="rounded-xl px-3 py-2 text-sm shadow bg-emerald-600 text-white">Log Try (no player)</button>
            <button onClick={()=>quickAction('TACKLE')} className="rounded-xl px-3 py-2 text-sm shadow bg-indigo-600 text-white">Log Tackle (no player)</button>
            <button onClick={()=>quickAction('OTHER')} className="rounded-xl px-3 py-2 text-sm shadow bg-gray-800 text-white">Other (note)</button>
          </div>
          <input value={noteDraft} onChange={(e)=>setNoteDraft(e.target.value)} placeholder="Optional note (not saved in this step)"
            className="mb-3 w-full rounded-xl border px-3 py-2"/>
        </div>
      </div>
    </div>
  )
}
