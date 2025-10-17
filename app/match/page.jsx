'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabaseBrowser } from '../../lib/supabase-browser'
import Link from 'next/link'

// keep all IDs as strings in React state
const sid = (v) => (v == null ? '' : String(v))

const fmt = (ms) => {
  const s = Math.floor(ms / 1000)
  const mm = Math.floor(s / 60)
  const ss = s % 60
  return `${mm.toString().padStart(2,'0')}:${ss.toString().padStart(2,'0')}`
}

// Stable sorter to avoid flicker
const byRosterOrder = (a, b) => {
  const as = a.shirt ?? Number.POSITIVE_INFINITY
  const bs = b.shirt ?? Number.POSITIVE_INFINITY
  if (as !== bs) return as - bs
  const an = (a.name || '').localeCompare(b.name || '')
  if (an !== 0) return an
  return String(a.id).localeCompare(String(b.id))
}

export default function MatchConsole() {
  const sb = supabaseBrowser()
  const router = useRouter()

  const [teams, setTeams] = useState([])
  const [teamId, setTeamId] = useState(null)
  const [opponent, setOpponent] = useState('Opposition U9')
  const [halfLengthMin, setHalfLengthMin] = useState(10)
  const [maxOnField, setMaxOnField] = useState(8)

  const [dark, setDark] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [matchMs, setMatchMs] = useState(0)
  const lastTickRef = useRef(null)

  const [matchId, setMatchId] = useState(null)
  const [matchStatus, setMatchStatus] = useState('draft') // 'draft' | 'live' | 'final'
  const [players, setPlayers] = useState([])         // home squad
  const [intervals, setIntervals] = useState([])     // {playerId, startMs, endMs}
  const [events, setEvents] = useState([])

  const [needsStarters, setNeedsStarters] = useState(false)
  const [starterIds, setStarterIds] = useState([])

  // availability for this match (local; persisted only by our actions)
  const [availableIds, setAvailableIds] = useState(new Set())
  const availInitialised = useRef(false) // prevent autosync from fighting toggles

  const [selectedBenchIds, setSelectedBenchIds] = useState([])
  const [selectedOnIds, setSelectedOnIds] = useState([])
  const [noteDraft, setNoteDraft] = useState('')

  // Guests / other squad
  const [otherSquad, setOtherSquad] = useState([])
  const [guests, setGuests] = useState([]) // player_id[]
  const [guestToAdd, setGuestToAdd] = useState('')
  const [guestMsg, setGuestMsg] = useState('')

  // avoid flicker after local writes when realtime refresh arrives
  const lastLocalWriteAt = useRef(0)

  // keys
  const keyForMatch = (tid) => `mk_match_id:${tid ?? 'none'}`
  const keyForAvail = (mid) => `mk_available:${mid ?? 'none'}`

  // timer loop
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

  // load squads
  useEffect(() => { (async () => {
    const { data } = await sb.from('team').select('id,name,squad').order('squad')
    setTeams(data||[])
    setTeamId(data?.[0]?.id || null)
  })() }, [])

  // load players for current squad
  useEffect(() => { (async () => {
    if (!teamId) return
    const { data } = await sb
      .from('player')
      .select('id, display_name, initials, shirt_number')
      .eq('team_id', teamId)
      .order('shirt_number', { nullsFirst: true })
    const normalized = (data||[]).map(p => ({
      id: sid(p.id),
      name: p.display_name?.trim() || p.initials || 'Player',
      shirt: p.shirt_number ?? null,
      guest: false
    }))
    setPlayers(normalized.sort(byRosterOrder))
  })() }, [teamId])

  // create or resume match for this squad
  useEffect(() => {
    const boot = async () => {
      if (!teamId) return
      let mid = localStorage.getItem(keyForMatch(teamId))
      if (mid) {
        const { data: m } = await sb.from('match')
          .select('id,team_id,status,half_length_minutes,max_on_field,opponent')
          .eq('id', mid).maybeSingle()
        if (m && m.team_id === teamId) {
          setMatchId(m.id); setMatchStatus(m.status)
          setHalfLengthMin(m.half_length_minutes || halfLengthMin)
          setMaxOnField(m.max_on_field || maxOnField)
          setOpponent(m.opponent || opponent)
          return
        }
      }
      const { data, error } = await sb.from('match').insert({
        team_id: teamId, opponent, half_length_minutes: halfLengthMin, max_on_field: maxOnField, status: 'draft'
      }).select('id,status').single()
      if (!error && data) {
        localStorage.setItem(keyForMatch(teamId), data.id)
        setMatchId(data.id); setMatchStatus(data.status)
      }
    }
    boot()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId])

  // load other squad players
  const loadOther = async (tid) => {
    const { data: allTeams } = await sb.from('team').select('id, squad, name').order('squad')
    const other = (allTeams||[]).find(t => t.id !== tid) // two squads assumption
    if (!other) { setOtherSquad([]); return }
    const { data: ps } = await sb.from('player')
      .select('id, display_name, initials, shirt_number')
      .eq('team_id', other.id)
      .order('shirt_number', { nullsFirst: true })
    const normalized = (ps||[]).map(p => ({
      id: sid(p.id),
      name: p.display_name?.trim() || p.initials || 'Player',
      shirt: p.shirt_number ?? null,
      guest: true
    }))
    setOtherSquad(normalized.sort(byRosterOrder))
  }
  useEffect(() => { if (teamId) loadOther(teamId) }, [teamId])

  // load guests for this match
  useEffect(() => {
    const loadGuests = async () => {
      if (!matchId) return
      const { data } = await sb.from('match_player').select('player_id').eq('match_id', matchId)
      setGuests((data||[]).map(r => sid(r.player_id)))
    }
    loadGuests()
  }, [matchId, sb])

  // merged list for this match (home + guests), with STABLE fallback for guests
  const playersAll = useMemo(() => {
    const map = new Map(players.map(p => [sid(p.id), { ...p, guest:false }]))
    const otherMap = new Map(otherSquad.map(p => [sid(p.id), p]))
    for (const gid of guests) {
      const g = otherMap.get(sid(gid)) || { id: sid(gid), name: 'Guest', shirt: null, guest: true }
      map.set(g.id, { ...g, guest: true })
    }
    return Array.from(map.values()).sort(byRosterOrder)
  }, [players, otherSquad, guests])

  // one-time availability init (from last saved, or default everyone)
  useEffect(() => {
    if (!matchId) return
    const raw = localStorage.getItem(keyForAvail(matchId))
    if (raw) {
      try { setAvailableIds(new Set(JSON.parse(raw))) }
      catch { setAvailableIds(new Set(playersAll.map(p=>sid(p.id)))) }
    } else {
      setAvailableIds(new Set(playersAll.map(p=>sid(p.id))))
    }
    availInitialised.current = true
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchId])

  // write-through persistence when availability changes
  useEffect(() => {
    if (!matchId || !availInitialised.current) return
    localStorage.setItem(keyForAvail(matchId), JSON.stringify(Array.from(availableIds)))
  }, [availableIds, matchId])

  // live refresh, lightly throttled after local writes
  useEffect(() => {
    if (!matchId) return
    const refresh = async () => {
      if (performance.now() - lastLocalWriteAt.current < 250) return
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
      setIntervals((pis||[]).map((r) => ({ playerId: sid(r.player_id), startMs: r.start_ms, endMs: r.end_ms ?? null })))
      setEvents((evs||[]).map((e) => ({ type: e.kind === 'SUB' ? 'SUB_BATCH' : e.kind, atMs: e.at_ms, playerId: e.player_id ? sid(e.player_id) : undefined, note: e.note ?? undefined })))
      setNeedsStarters((pis||[]).length === 0 && matchStatus !== 'final')

      // restore availability from last AVAIL event if never initialised
      if (!localStorage.getItem(keyForAvail(matchId))) {
        const lastAvail = [...(evs||[])].reverse().find((e)=>e.kind==='AVAIL' && e.note)
        if (lastAvail) {
          try {
            const ids = new Set(JSON.parse(lastAvail.note).map(sid))
            setAvailableIds(ids)
            localStorage.setItem(keyForAvail(matchId), JSON.stringify(Array.from(ids)))
            availInitialised.current = true
          } catch {/* ignore */}
        }
      }
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

  const isFinal  = matchStatus === 'final'
  const isLocked = matchStatus !== 'draft'

  // Sets for fast checks
  const onFieldIdSet = useMemo(() => {
    const s = new Set()
    for (const i of intervals) if (i.endMs == null) s.add(sid(i.playerId))
    return s
  }, [intervals])

  // derive on-field/bench from merged list, filtered by availability
  const availableList = useMemo(() => playersAll.filter(p => availableIds.has(sid(p.id))), [playersAll, availableIds])
  const unavailableList = useMemo(() => playersAll.filter(p => !availableIds.has(sid(p.id))), [playersAll, availableIds])

  const onField = useMemo(() => availableList.filter(p => onFieldIdSet.has(sid(p.id))), [availableList, onFieldIdSet])
  const bench   = useMemo(() => availableList.filter(p => !onFieldIdSet.has(sid(p.id))), [availableList, onFieldIdSet])

  // minutes aggregation
  const minutesByPlayer = useMemo(() => {
    const map = new Map()
    for (const i of intervals) {
      const end = i.endMs ?? matchMs
      const dur = Math.max(0, end - i.startMs)
      const k = sid(i.playerId)
      map.set(k, (map.get(k) ?? 0) + dur)
    }
    return map
  }, [intervals, matchMs])

  // starters
  const toggleStarter = (pid) =>
    setStarterIds(ids => ids.includes(sid(pid)) ? ids.filter(x=>x!==sid(pid)) : [...ids, sid(pid)])

  // availability toggle
  const toggleAvailable = (pid) => {
    if (!matchId) return
    setAvailableIds(prev => {
      const next = new Set(prev)
      const k = sid(pid)
      if (next.has(k)) next.delete(k); else next.add(k)
      return next
    })
  }

  const confirmStarters = async () => {
    if (!matchId) return
    if (starterIds.length !== maxOnField) return
    if (!starterIds.every(id => availableIds.has(sid(id)))) return

    const rows = starterIds.map(id => ({ match_id: matchId, player_id: sid(id), start_ms: 0 }))
    lastLocalWriteAt.current = performance.now()
    const { error } = await sb.from('playing_interval').insert(rows)
    if (!error) {
      setIntervals(rows.map(r => ({ playerId: sid(r.player_id), startMs: 0, endMs: null })))
      setNeedsStarters(false)
      await sb.from('match').update({ status: 'live', started_at: new Date().toISOString() }).eq('id', matchId)
      setMatchStatus('live')
      // store availability snapshot as event
      await sb.from('event').insert({
        match_id: matchId,
        kind: 'AVAIL',
        at_ms: 0,
        note: JSON.stringify(Array.from(availableIds))
      })
    }
  }

  // Balancing pool excludes guests + absentees
  const homeBalancingPool = useMemo(
    () => availableList.filter(p => !p.guest),
    [availableList]
  )

  const fullGameMs = halfLengthMin * 2 * 60 * 1000
  const fullTarget = homeBalancingPool.length ? (fullGameMs * maxOnField) / homeBalancingPool.length : 0
  const deficit = (pid) => fullTarget - (minutesByPlayer.get(sid(pid)) ?? 0)

  const suggestRotation = () => {
    const sOff = [...onField].sort((a,b) => (minutesByPlayer.get(sid(b.id)) ?? 0) - (minutesByPlayer.get(sid(a.id)) ?? 0))
    const sOn  = [...bench].sort((a,b) => deficit(b.id) - deficit(a.id))
    const n = Math.min(sOff.length, sOn.length, maxOnField)
    setSelectedOnIds(sOff.slice(0,n).map(p=>sid(p.id)))
    setSelectedBenchIds(sOn.slice(0,n).map(p=>sid(p.id)))
  }

  const confirmBatch = async () => {
    if (!matchId) return
    const n = Math.min(selectedBenchIds.length, selectedOnIds.length)
    const pairs = Array.from({length:n}, (_,i)=>({ onId: sid(selectedBenchIds[i]), offId: sid(selectedOnIds[i]) }))
    setIntervals(cur => {
      let u = [...cur]
      for (const {offId,onId} of pairs) {
        const idx = u.findIndex(it => sid(it.playerId) === offId && it.endMs == null)
        if (idx >= 0) u[idx] = { ...u[idx], endMs: matchMs }
        u.push({ playerId: sid(onId), startMs: matchMs, endMs: null })
      }
      return u
    })
    setSelectedBenchIds([]); setSelectedOnIds([])
    lastLocalWriteAt.current = performance.now()
    for (const { offId } of pairs) {
      await sb.from('playing_interval').update({ end_ms: Math.floor(matchMs) }).eq('match_id', matchId).eq('player_id', offId).is('end_ms', null)
    }
    for (const { onId } of pairs) {
      await sb.from('playing_interval').insert({ match_id: matchId, player_id: onId, start_ms: Math.floor(matchMs) })
    }
    await sb.from('event').insert({ match_id: matchId, kind: 'SUB', at_ms: Math.floor(matchMs), note: JSON.stringify(pairs) })
  }

  const removeNoReplace = async (pid) => {
    if (!matchId) return
    setIntervals(cur => {
      const idx = cur.findIndex(it => sid(it.playerId) === sid(pid) && it.endMs == null)
      if (idx >= 0) { const u=[...cur]; u[idx]={...u[idx], endMs: matchMs}; return u }
      return cur
    })
    lastLocalWriteAt.current = performance.now()
    await sb.from('playing_interval').update({ end_ms: Math.floor(matchMs) }).eq('match_id', matchId).eq('player_id', sid(pid)).is('end_ms', null)
  }

  // quick events
  const quickAction = async (kind, playerId) => {
    if (!matchId) return
    lastLocalWriteAt.current = performance.now()
    await sb.from('event').insert({ match_id: matchId, player_id: playerId ? sid(playerId) : null, at_ms: Math.floor(matchMs), kind, note: noteDraft || null })
  }

  // reset / end / new / reopen
  const resetMatch = async () => {
    if (!matchId) return
    if (!confirm('Reset this match setup? This will clear starters, intervals and events.')) return
    lastLocalWriteAt.current = performance.now()
    await sb.from('playing_interval').delete().eq('match_id', matchId)
    await sb.from('event').delete().eq('match_id', matchId)
    await sb.from('match').update({ status: 'draft', started_at: null }).eq('id', matchId)
    setIntervals([]); setEvents([]); setMatchStatus('draft'); setNeedsStarters(true); setStarterIds([])
    setIsRunning(false); setMatchMs(0)
    // clear availability for this match
    localStorage.removeItem(keyForAvail(matchId))
    setAvailableIds(new Set(playersAll.map(p=>sid(p.id))))
    availInitialised.current = true
  }

  const endGame = async () => {
    if (!matchId) return
    if (!confirm('End game and commit stats?')) return
    lastLocalWriteAt.current = performance.now()
    await sb.from('match').update({ status: 'final', completed_at: new Date().toISOString() }).eq('id', matchId)
    setMatchStatus('final')
    router.push(`/summary/${matchId}`)
  }

  const newMatch = async () => {
    if (!teamId) return
    lastLocalWriteAt.current = performance.now()
    const { data, error } = await sb.from('match').insert({
      team_id: teamId,
      opponent,
      half_length_minutes: halfLengthMin,
      max_on_field: maxOnField,
      status: 'draft',
    }).select('id,status').single()
    if (!error && data) {
      localStorage.setItem(keyForMatch(teamId), data.id)
      setMatchId(data.id)
      setMatchStatus('draft')
      setIntervals([]); setEvents([]); setStarterIds([])
      setIsRunning(false); setMatchMs(0); setNeedsStarters(true)
      // start with everyone available in the new match
      const everyone = playersAll.map(p=>sid(p.id))
      localStorage.setItem(keyForAvail(data.id), JSON.stringify(everyone))
      setAvailableIds(new Set(everyone))
      availInitialised.current = true
    }
  }

  const reopenMatch = async () => {
    if (!matchId) return
    if (!confirm('Reopen this match for editing?')) return
    lastLocalWriteAt.current = performance.now()
    await sb.from('match').update({ status: 'draft' }).eq('id', matchId)
    setMatchStatus('draft')
  }

  const controlDisabled = isFinal || needsStarters
  const settingsDisabled = isLocked

  const barFor = (pid) => {
    const played = minutesByPlayer.get(sid(pid)) ?? 0
    const fullGameMs = halfLengthMin * 2 * 60 * 1000
    const fullTarget = (availableList.filter(p=>!p.guest).length)
      ? (fullGameMs * maxOnField) / (availableList.filter(p=>!p.guest).length)
      : 0
    const pct = fullTarget > 0 ? Math.min(100, (played / fullTarget) * 100) : 0
    return (
      <div className="mt-1 bar">
        <div className="bar-fill" style={{ width: `${pct}%` }} />
        <div className="bar-target" style={{ left: '100%' }} />
      </div>
    )
  }

  return (
    <div className={dark ? 'dark' : ''}>
      <div className="space-y-4">
        {/* Header */}
        <div className="mb-2 flex items-center justify-between">
          <div>
            <div className="text-xl font-bold tracking-tight">Mighty Knights — Match Console</div>
            <div className="text-xs text-gray-500">
              {teams.find(t=>t.id===teamId)?.squad?.toUpperCase()} • vs {opponent} • {halfLengthMin}′ halves • {maxOnField}-a-side
            </div>
            {matchId && <div className="text-[10px] text-gray-400">Match ID: {String(matchId).slice(0,8)}… • Status: {matchStatus}</div>}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={()=>setDark(d=>!d)} className="btn btn-outline">{dark?'Light':'Dark'} mode</button>
            <Link href="/history" className="btn btn-ghost">History</Link>
          </div>
        </div>

        {/* Settings */}
        <div className="panel panel-narrow grid grid-cols-1 gap-3 sm:gap-4 md:grid-cols-4 touch-top">
          <label className="block text-sm">Squad
            <select value={teamId||''} onChange={(e)=>setTeamId(e.target.value)} className="field field-dark mt-1" disabled={settingsDisabled}>
              {teams.map(t => <option key={t.id} value={t.id}>{t.name} — {t.squad.toUpperCase()}</option>)}
            </select>
          </label>
          <label className="block text-sm">Team size (a-side)
            <select value={maxOnField} onChange={(e)=>setMaxOnField(parseInt(e.target.value))} className="field field-dark mt-1" disabled={settingsDisabled}>
              {[6,7,8,9,10].map(v=> <option key={v} value={v}>{v} a-side</option>)}
            </select>
          </label>
          <label className="block text-sm">Half length
            <select value={halfLengthMin} onChange={(e)=>setHalfLengthMin(parseInt(e.target.value))} className="field field-dark mt-1" disabled={settingsDisabled}>
              {Array.from({length:8},(_,i)=>i+8).map(v=> <option key={v} value={v}>{v} minutes</option>)}
            </select>
          </label>
          <label className="block text-sm">Opponent
            <input value={opponent} onChange={(e)=>setOpponent(e.target.value)} className="field field-dark mt-1" disabled={settingsDisabled}/>
          </label>
        </div>

        {/* Attendance + Starter picker */}
        {needsStarters && (
          <div className="card card-narrow z-0">
            <div className="mb-2 text-sm font-semibold">Who’s here today?</div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
              {playersAll.map(p => {
                const here = availableIds.has(sid(p.id))
                return (
                  <button key={`avail-${p.id}`}
                    onClick={()=>toggleAvailable(p.id)}
                    className={`rounded-2xl border px-3 py-2 text-left shadow-soft bg-white ${here?'ring-2 ring-emerald-400':''}`}>
                    <div className="font-medium">
                      {p.name} {p.shirt ? `#${p.shirt}` : ''} {p.guest && <span className="ml-2 chip chip-warn">Guest</span>}
                    </div>
                    <div className="text-[11px] text-gray-500">{here?'Available':'Absent'}</div>
                  </button>
                )
              })}
            </div>
            <div className="mt-3 text-xs text-gray-600">
              Available: {availableList.length} • Absent: {unavailableList.length}
            </div>

            <div className="mt-6 mb-2 text-sm font-semibold">Select your starting {maxOnField}</div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
              {availableList.map(p => {
                const selected = starterIds.includes(sid(p.id))
                return (
                  <button key={`starter-${p.id}`} onClick={()=>toggleStarter(p.id)}
                    className={`rounded-2xl border px-3 py-2 text-left shadow-soft bg-white ${selected?'ring-2 ring-mk-gold':''}`}>
                    <div className="font-medium">{p.name} {p.guest && <span className="ml-2 chip chip-warn">Guest</span>}</div>
                    {p.shirt && <div className="text-xs text-gray-500">#{p.shirt}</div>}
                  </button>
                )
              })}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <button onClick={confirmStarters}
                disabled={
                  starterIds.length !== maxOnField ||
                  !starterIds.every(id => availableIds.has(sid(id)))
                }
                className={`btn ${
                  (starterIds.length===maxOnField && starterIds.every(id=>availableIds.has(sid(id))))
                  ? 'btn-emerald'
                  : 'btn-ghost text-gray-400'
                }`}
              >
                Set Starters ({starterIds.length}/{maxOnField})
              </button>
              <div className="text-xs text-gray-600">Pick exactly {maxOnField} from the available players.</div>
            </div>
          </div>
        )}

        {/* Clock & actions */}
        <div className="card card-narrow flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-sm text-gray-500">Match Clock</div>
            <div className="text-6xl font-extrabold tabular-nums">{fmt(matchMs)}</div>
            <div className="text-xs text-gray-500">On field: {onField.length}/{maxOnField} • Bench: {bench.length}</div>
          </div>
          <div className="stack-sm w-full sm:w-auto">
            <button
              onClick={()=>setIsRunning(v=>!v)}
              disabled={isFinal || needsStarters}
              className={`btn ${isRunning?'btn-primary bg-mk-crimson':'btn-emerald'} ${(isFinal || needsStarters)?'opacity-50':''} w-full sm:w-auto`}
            >
              {isRunning?'Pause':'Start'}
            </button>
            <button onClick={resetMatch} className="btn btn-outline w-full sm:w-auto">Reset</button>
            <button onClick={newMatch} className="btn btn-ghost w-full sm:w-auto">New match</button>
            <button onClick={endGame} className="btn bg-dk-navy text-white w-full sm:w-auto" disabled={isFinal}>End game</button>
            {isFinal && (
              <button onClick={reopenMatch} className="btn btn-ghost w-full sm:w-auto">Reopen</button>
            )}
          </div>
        </div>

        {/* Add guest from other squad */}
        <div className="card card-narrow">
          <label className="block text-sm font-medium mb-1">Borrow a player (guest)</label>
          <div className="stack-sm">
            <select
              className="field field-dark w-full sm:w-72"
              value={guestToAdd}
              onChange={(e)=>setGuestToAdd(sid(e.target.value))}
            >
              <option value="">Select from other squad…</option>
              {otherSquad
                .filter(p => !playersAll.some(x => sid(x.id) === sid(p.id))) // hide already-added
                .map(p => (
                  <option key={p.id} value={p.id}>{p.name}{p.shirt ? ` #${p.shirt}` : ''}</option>
                ))}
            </select>

            <button
              className="btn btn-outline w-full sm:w-auto"
              onClick={async () => {
                if (!guestToAdd) { setGuestMsg('Choose a player first.'); return }
                if (!matchId) { setGuestMsg('No match yet — tap New match.'); return }
                lastLocalWriteAt.current = performance.now()
                const { error } = await sb
                  .from('match_player')
                  .upsert({ match_id: matchId, player_id: guestToAdd, is_guest: true }, { onConflict: 'match_id,player_id' })
                if (error) {
                  console.error(error)
                  setGuestMsg(`Couldn’t add guest: ${error.message}`)
                  return
                }
                setGuests(g => g.includes(guestToAdd) ? g : [...g, guestToAdd])
                setAvailableIds(prev => { const next = new Set(prev); next.add(guestToAdd); return next })
                setGuestToAdd('')
                setGuestMsg('Guest added ✓ (see Bench)')
                setTimeout(()=>setGuestMsg(''), 2000)
              }}
            >
              Add guest
            </button>
          </div>
          {guestMsg && <p className="mt-1 text-[11px] text-gray-600">{guestMsg}</p>}
          <p className="mt-1 text-[11px] text-gray-500">
            Guests appear only in this game. Their home squad doesn’t change.
          </p>
        </div>

        {/* On Field & Bench */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="card card-narrow lg:col-span-2">
            <h2 className="mb-2 text-lg font-semibold">On Field ({onField.length}/{maxOnField})</h2>
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
              {onField.map(p => {
                const played = minutesByPlayer.get(sid(p.id)) ?? 0
                const selected = selectedOnIds.includes(sid(p.id))
                const fullGameMs = halfLengthMin * 2 * 60 * 1000
                const fullTarget = (availableList.filter(x=>!x.guest).length)
                  ? (fullGameMs * maxOnField) / (availableList.filter(x=>!x.guest).length)
                  : 0
                const delta = played - fullTarget
                const chipClass = delta > 60000 ? 'chip-bad' : delta < -60000 ? 'chip-ok' : 'chip-muted'
                return (
                  <li key={p.id} className={`rounded-2xl border px-3 py-2 bg-[var(--surface)] shadow-soft ${selected?'ring-2 ring-mk-gold':''}`}>
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-medium truncate">
                            {p.name} {p.shirt ? `#${p.shirt}` : ''} {p.guest && <span className="ml-2 chip chip-warn">Guest</span>}
                          </div>
                          <div className="text-xs text-gray-500">⏱ {fmt(played)}</div>
                          {barFor(p.id)}
                          <div className={`mt-1 ${chipClass}`}>{(delta>=0?'+':'-') + fmt(Math.abs(delta))}</div>
                        </div>
                        <div className="flex gap-1">
                          <button onClick={()=>setSelectedOnIds(ids=>ids.includes(sid(p.id))?ids.filter(x=>x!==sid(p.id)):[...ids,sid(p.id)])}
                            className="btn btn-ghost">{selected?'Selected':'Mark OFF'}</button>
                          <button onClick={()=>removeNoReplace(p.id)} className="btn btn-ghost">Remove</button>
                        </div>
                      </div>
                      <div className="stack-sm justify-end">
                        <button onClick={()=>quickAction('TRY', p.id)} className="btn btn-emerald">Try</button>
                        <button onClick={()=>quickAction('TACKLE', p.id)} className="btn btn-indigo">Tackle</button>
                        <button onClick={()=>quickAction('OTHER', p.id)} className="btn btn-outline">Other</button>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>

          <div className="card card-narrow">
            <h2 className="mb-2 text-lg font-semibold">Bench</h2>
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {bench.map(p => {
                const played = minutesByPlayer.get(sid(p.id)) ?? 0
                const selected = selectedBenchIds.includes(sid(p.id))
                return (
                  <li key={p.id} className={`rounded-2xl border px-3 py-2 bg-[var(--surface)] shadow-soft ${selected?'ring-2 ring-mk-gold':''}`}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-medium truncate">
                          {p.name} {p.shirt ? `#${p.shirt}` : ''} {p.guest && <span className="ml-2 chip chip-warn">Guest</span>}
                        </div>
                        <div className="text-xs text-gray-500">⏱ {fmt(played)}</div>
                        {barFor(p.id)}
                      </div>
                      <div className="flex flex-col gap-1 items-end">
                        {onField.length < maxOnField ? (
                          <button
                            className="btn btn-emerald"
                            onClick={async () => {
                              if (!matchId) return
                              setIntervals(u => [...u, { playerId: sid(p.id), startMs: matchMs, endMs: null }])
                              lastLocalWriteAt.current = performance.now()
                              await sb.from('playing_interval').insert({ match_id: matchId, player_id: sid(p.id), start_ms: Math.floor(matchMs) })
                            }}
                          >
                            Send on now
                          </button>
                        ) : (
                          <button
                            onClick={()=>setSelectedBenchIds(ids=>ids.includes(sid(p.id))?ids.filter(x=>x!==sid(p.id)):[...ids,sid(p.id)])}
                            className="btn btn-ghost"
                          >
                            {selected ? 'Selected' : 'Mark ON'}
                          </button>
                        )}

                        {p.guest && (
                          <button
                            className="btn btn-ghost"
                            disabled={onFieldIdSet.has(sid(p.id))}
                            title={onFieldIdSet.has(sid(p.id)) ? 'Sub off before removing guest' : 'Remove guest'}
                            onClick={async () => {
                              if (!matchId) return
                              lastLocalWriteAt.current = performance.now()
                              await sb.from('match_player').delete().eq('match_id', matchId).eq('player_id', sid(p.id))
                              setGuests(gs => gs.filter(id => id !== sid(p.id)))
                              setAvailableIds(prev => { const next = new Set(prev); next.delete(sid(p.id)); return next })
                            }}
                          >
                            Remove guest
                          </button>
                        )}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>

            <div className="mt-3 flex flex-wrap gap-2">
              <button onClick={suggestRotation} className="btn btn-outline">Suggest rotation (now)</button>
              <button onClick={confirmBatch}
                disabled={!selectedBenchIds.length || !selectedOnIds.length || selectedBenchIds.length !== selectedOnIds.length}
                className={`btn ${selectedBenchIds.length && selectedOnIds.length && selectedBenchIds.length === selectedOnIds.length ? 'btn-primary' : 'btn-ghost text-gray-400'}`}>
                Confirm batch ({Math.min(selectedBenchIds.length, selectedOnIds.length)})
              </button>
              <button onClick={()=>{ setSelectedBenchIds([]); setSelectedOnIds([]) }} className="btn btn-ghost">Clear</button>
            </div>

            {unavailableList.length > 0 && (
              <div className="mt-4">
                <h3 className="mb-1 text-sm font-semibold text-gray-600">Marked Absent</h3>
                <div className="text-xs text-gray-500">
                  {unavailableList.map(p => p.name).join(', ')}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Quick actions (no player) */}
        <div className="card p-4">
          <h3 className="mb-3 text-lg font-semibold">Quick Actions</h3>
          <div className="mb-3 grid grid-cols-3 gap-2">
            <button onClick={()=>quickAction('TRY')} className="btn btn-emerald">Log Try (no player)</button>
            <button onClick={()=>quickAction('TACKLE')} className="btn btn-indigo">Log Tackle (no player)</button>
            <button onClick={()=>quickAction('OTHER')} className="btn btn-outline">Other (note)</button>
          </div>
          <input value={noteDraft} onChange={(e)=>setNoteDraft(e.target.value)} placeholder="Optional note"
            className="field field-dark" />
        </div>
      </div>
    </div>
  )
}
