'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabaseBrowser } from '../../lib/supabase-browser'
import Link from 'next/link'

const fmt = (ms: number) => {
  const s = Math.floor(ms / 1000)
  const mm = Math.floor(s / 60)
  const ss = s % 60
  return `${mm.toString().padStart(2,'0')}:${ss.toString().padStart(2,'0')}`
}

// Stable sorter used everywhere to avoid list reshuffles/flicker
const byRosterOrder = (
  a: {shirt:number|null, name:string, id:string|number},
  b: {shirt:number|null, name:string, id:string|number}
) => {
  const as = a.shirt ?? Number.POSITIVE_INFINITY
  const bs = b.shirt ?? Number.POSITIVE_INFINITY
  if (as !== bs) return as - bs
  const an = (a.name||'').localeCompare(b.name||'')
  if (an !== 0) return an
  return String(a.id).localeCompare(String(b.id))
}

export default function MatchConsole() {
  const sb = supabaseBrowser()
  const router = useRouter()

  const [teams, setTeams] = useState<any[]>([])
  const [teamId, setTeamId] = useState<string|null>(null)
  const [opponent, setOpponent] = useState('Opposition U9')
  const [halfLengthMin, setHalfLengthMin] = useState(10)
  const [maxOnField, setMaxOnField] = useState(8)

  const [dark, setDark] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [matchMs, setMatchMs] = useState(0)
  const lastTickRef = useRef<number|null>(null)

  const [matchId, setMatchId] = useState<string|null>(null)
  const [matchStatus, setMatchStatus] = useState<'draft'|'live'|'final'>('draft')
  const [players, setPlayers] = useState<any[]>([])         // home squad
  const [intervals, setIntervals] = useState<{playerId:any,startMs:number,endMs:number|null}[]>([])
  const [events, setEvents] = useState<any[]>([])

  const [needsStarters, setNeedsStarters] = useState(false)
  const [starterIds, setStarterIds] = useState<any[]>([])

  // NEW: attendance (availability) for this match
  const [availableIds, setAvailableIds] = useState<Set<any>>(new Set())

  const [selectedBenchIds, setSelectedBenchIds] = useState<any[]>([])
  const [selectedOnIds, setSelectedOnIds] = useState<any[]>([])
  const [noteDraft, setNoteDraft] = useState('')

  // Guests / other squad
  const [otherSquad, setOtherSquad] = useState<any[]>([])
  const [guests, setGuests] = useState<any[]>([]) // array of player_ids added as guests
  const [guestToAdd, setGuestToAdd] = useState<any>('')
  const [guestMsg, setGuestMsg] = useState('')

  // throttle window to avoid server-push → local flicker after we just wrote
  const lastLocalWriteAt = useRef<number>(0)

  // namespaced keys
  const keyForMatch = (tid: any) => `mk_match_id:${tid ?? 'none'}`
  const keyForAvail = (mid: any) => `mk_available:${mid ?? 'none'}`

  // timer loop — single source of truth
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
      id: p.id,
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
        const { data: m } = await sb.from('match').select('id,team_id,status,half_length_minutes,max_on_field,opponent').eq('id', mid).maybeSingle()
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
  const loadOther = async (tid: any) => {
    const { data: allTeams } = await sb.from('team').select('id, squad, name').order('squad')
    const other = (allTeams||[]).find(t => t.id !== tid) // two squads assumption
    if (!other) { setOtherSquad([]); return }
    const { data: ps } = await sb.from('player')
      .select('id, display_name, initials, shirt_number')
      .eq('team_id', other.id)
      .order('shirt_number', { nullsFirst: true })
    const normalized = (ps||[]).map(p => ({
      id: p.id,
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
      setGuests((data||[]).map(r => r.player_id))
    }
    loadGuests()
  }, [matchId, sb])

  // merged list for this match (home + guests), sorted deterministically
  const playersAll = useMemo(() => {
    const map = new Map(players.map(p => [p.id, { ...p, guest:false }]))
    for (const gid of guests) {
      const g = otherSquad.find(p => p.id === gid)
      if (g) map.set(g.id, { ...g, guest:true })
    }
    return Array.from(map.values()).sort(byRosterOrder)
  }, [players, otherSquad, guests])

  // availability: load from localStorage or infer default (everyone present)
  useEffect(() => {
    if (!matchId) return
    const raw = localStorage.getItem(keyForAvail(matchId))
    if (raw) {
      try {
        const ids = new Set<any>(JSON.parse(raw))
        setAvailableIds(ids)
      } catch { setAvailableIds(new Set(playersAll.map(p=>p.id))) }
    } else {
      setAvailableIds(new Set(playersAll.map(p=>p.id)))
    }
  }, [matchId])

  // keep availability in sync if player list changes (e.g., guest added)
  useEffect(() => {
    if (!matchId) return
    setAvailableIds(prev => {
      const next = new Set(prev)
      for (const p of playersAll) if (!next.has(p.id)) next.add(p.id) // auto-include new players (e.g., guests)
      // prune ids that no longer exist
      for (const id of Array.from(next)) if (!playersAll.find(p=>p.id===id)) next.delete(id)
      localStorage.setItem(keyForAvail(matchId), JSON.stringify(Array.from(next)))
      return next
    })
  }, [playersAll, matchId])

  // live refresh, lightly throttled after local writes to avoid flicker
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
      setIntervals((pis||[]).map((r:any) => ({ playerId: r.player_id, startMs: r.start_ms, endMs: r.end_ms ?? null })))
      setEvents((evs||[]).map((e:any) => ({ type: e.kind === 'SUB' ? 'SUB_BATCH' : e.kind, atMs: e.at_ms, playerId: e.player_id ?? undefined, note: e.note ?? undefined })))
      setNeedsStarters((pis||[]).length === 0 && matchStatus !== 'final')
      // try to restore availability from last AVAIL event if localStorage empty
      if (!localStorage.getItem(keyForAvail(matchId))) {
        const lastAvail = [...(evs||[])].reverse().find((e:any)=>e.kind==='AVAIL' && e.note)
        if (lastAvail) {
          try {
            const ids = new Set<any>(JSON.parse(lastAvail.note))
            setAvailableIds(ids)
            localStorage.setItem(keyForAvail(matchId), lastAvail.note)
          } catch { /* ignore */ }
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

  const isLocked = matchStatus !== 'draft'
  const isFinal  = matchStatus === 'final'

  // Sets for fast checks
  const onFieldIdSet = useMemo(() => {
    const s = new Set<any>()
    for (const i of intervals) if (i.endMs == null) s.add(i.playerId)
    return s
  }, [intervals])

  // derive on-field/bench from merged list, filtered by availability
  const availableList = useMemo(() => playersAll.filter(p => availableIds.has(p.id)), [playersAll, availableIds])
  const unavailableList = useMemo(() => playersAll.filter(p => !availableIds.has(p.id)), [playersAll, availableIds])

  const onField = useMemo(() => availableList.filter(p => onFieldIdSet.has(p.id)), [availableList, onFieldIdSet])
  const bench   = useMemo(() => availableList.filter(p => !onFieldIdSet.has(p.id)), [availableList, onFieldIdSet])

  // minutes aggregation
  const minutesByPlayer = useMemo(() => {
    const map = new Map<any, number>()
    for (const i of intervals) {
      const end = i.endMs ?? matchMs
      const dur = Math.max(0, end - i.startMs)
      map.set(i.playerId, (map.get(i.playerId) ?? 0) + dur)
    }
    return map
  }, [intervals, matchMs])

  // starters
  const toggleStarter = (pid: any) =>
    setStarterIds(ids => ids.includes(pid) ? ids.filter(x=>x!==pid) : [...ids, pid])

  // NEW: toggle availability
  const toggleAvailable = (pid: any) => {
    if (!matchId) return
    setAvailableIds(prev => {
      const next = new Set(prev)
      if (next.has(pid)) next.delete(pid); else next.add(pid)
      localStorage.setItem(keyForAvail(matchId), JSON.stringify(Array.from(next)))
      return next
    })
  }

  const confirmStarters = async () => {
    // enforce starters ⊆ available and exact count
    if (starterIds.length !== maxOnField) return
    if (!starterIds.every(id => availableIds.has(id))) return

    const rows = starterIds.map(id => ({ match_id: matchId, player_id: id, start_ms: 0 }))
    lastLocalWriteAt.current = performance.now()
    const { error } = await sb.from('playing_interval').insert(rows)
    if (!error) {
      setIntervals(rows.map(r => ({ playerId: r.player_id, startMs: 0, endMs: null })))
      setNeedsStarters(false)
      await sb.from('match').update({ status: 'live', started_at: new Date().toISOString() }).eq('id', matchId!)
      setMatchStatus('live')
      // persist availability as an event for audit/recovery
      await sb.from('event').insert({
        match_id: matchId!,
        kind: 'AVAIL',
        at_ms: 0,
        note: JSON.stringify(Array.from(availableIds))
      })
    }
  }

  // --- BALANCING POOL ---
  // Exclude guests and anyone unavailable from even-time target to prevent judder and wrong targets.
  const homeBalancingPool = useMemo(
    () => availableList.filter(p => !p.guest),
    [availableList]
  )

  const fullGameMs = halfLengthMin * 2 * 60 * 1000
  const fullTarget = homeBalancingPool.length ? (fullGameMs * maxOnField) / homeBalancingPool.length : 0
  const deficit = (pid: any) => fullTarget - (minutesByPlayer.get(pid) ?? 0)

  const suggestRotation = () => {
    const sOff = [...onField].sort((a,b) => (minutesByPlayer.get(b.id) ?? 0) - (minutesByPlayer.get(a.id) ?? 0))
    const sOn  = [...bench].sort((a,b) => deficit(b.id) - deficit(a.id))
    const n = Math.min(sOff.length, sOn.length, maxOnField)
    setSelectedOnIds(sOff.slice(0,n).map(p=>p.id))
    setSelectedBenchIds(sOn.slice(0,n).map(p=>p.id))
  }

  const confirmBatch = async () => {
    const n = Math.min(selectedBenchIds.length, selectedOnIds.length)
    const pairs = Array.from({length:n}, (_,i)=>({ onId: selectedBenchIds[i], offId: selectedOnIds[i] }))
    setIntervals(cur => {
      let u = [...cur]
      for (const {offId,onId} of pairs) {
        const idx = u.findIndex(it => it.playerId === offId && it.endMs == null)
        if (idx >= 0) u[idx] = { ...u[idx], endMs: matchMs }
        u.push({ playerId: onId, startMs: matchMs, endMs: null })
      }
      return u
    })
    setSelectedBenchIds([]); setSelectedOnIds([])
    lastLocalWriteAt.current = performance.now()
    for (const { offId } of pairs) {
      await sb.from('playing_interval').update({ end_ms: Math.floor(matchMs) }).eq('match_id', matchId!).eq('player_id', offId).is('end_ms', null)
    }
    for (const { onId } of pairs) {
      await sb.from('playing_interval').insert({ match_id: matchId!, player_id: onId, start_ms: Math.floor(matchMs) })
    }
    await sb.from('event').insert({ match_id: matchId!, kind: 'SUB', at_ms: Math.floor(matchMs), note: JSON.stringify(pairs) })
  }

  const removeNoReplace = async (pid: any) => {
    setIntervals(cur => {
      const idx = cur.findIndex(it => it.playerId === pid && it.endMs == null)
      if (idx >= 0) { const u=[...cur]; u[idx]={...u[idx], endMs: matchMs}; return u }
      return cur
    })
    lastLocalWriteAt.current = performance.now()
    await sb.from('playing_interval').update({ end_ms: Math.floor(matchMs) }).eq('match_id', matchId!).eq('player_id', pid).is('end_ms', null)
  }

  // quick events
  const quickAction = async (kind: string, playerId?: any) => {
    lastLocalWriteAt.current = performance.now()
    await sb.from('event').insert({ match_id: matchId!, player_id: playerId ?? null, at_ms: Math.floor(matchMs), kind, note: noteDraft || null })
  }

  // reset / end / new / reopen
  const resetMatch = async () => {
    if (!confirm('Reset this match setup? This will clear starters, intervals and events.')) return
    lastLocalWriteAt.current = performance.now()
    await sb.from('playing_interval').delete().eq('match_id', matchId!)
    await sb.from('event').delete().eq('match_id', matchId!)
    await sb.from('match').update({ status: 'draft', started_at: null }).eq('id', matchId!)
    setIntervals([]); setEvents([]); setMatchStatus('draft'); setNeedsStarters(true); setStarterIds([])
    setIsRunning(false); setMatchMs(0)
    // clear availability for this match
    localStorage.removeItem(keyForAvail(matchId))
    setAvailableIds(new Set(playersAll.map(p=>p.id)))
  }

  const endGame = async () => {
    if (!confirm('End game and commit stats?')) return
    lastLocalWriteAt.current = performance.now()
    await sb.from('match').update({ status: 'final', completed_at: new Date().toISOString() }).eq('id', matchId!)
    setMatchStatus('final')
    router.push(`/summary/${matchId}`)
  }

  const newMatch = async () => {
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
      localStorage.setItem(keyForAvail(data.id), JSON.stringify(playersAll.map(p=>p.id)))
      setAvailableIds(new Set(playersAll.map(p=>p.id)))
    }
  }

  const reopenMatch = async () => {
    if (!confirm('Reopen this match for editing?')) return
    lastLocalWriteAt.current = performance.now()
    await sb.from('match').update({ status: 'draft' }).eq('id', matchId!)
    setMatchStatus('draft')
  }

  const controlDisabled = isFinal || needsStarters
  const settingsDisabled = isLocked

  const barFor = (pid: any) => {
    const played = minutesByPlayer.get(pid) ?? 0
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
                const here = availableIds.has(p.id)
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
                const selected = starterIds.includes(p.id)
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
                  !starterIds.every(id => availableIds.has(id))
                }
                className={`btn ${
                  (starterIds.length===maxOnField && starterIds.every(id=>availableIds.has(id)))
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
              onChange={(e)=>setGuestToAdd(e.target.value)}
            >
              <option value="">Select from other squad…</option>
              {otherSquad
                .filter(p => !playersAll.some(x => x.id === p.id)) // hide already-added
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
                // ensure new guest is marked available
                setAvailableIds(prev => {
                  const next = new Set(prev); next.add(guestToAdd)
                  localStorage.setItem(keyForAvail(matchId), JSON.stringify(Array.from(next)))
                  return next
                })
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
                const played = minutesByPlayer.get(p.id) ?? 0
                const selected = selectedOnIds.includes(p.id)
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
                          <button onClick={()=>setSelectedOnIds(ids=>ids.includes(p.id)?ids.filter(x=>x!==p.id):[...ids,p.id])}
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
                const played = minutesByPlayer.get(p.id) ?? 0
                const selected = selectedBenchIds.includes(p.id)
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
                              setIntervals(u => [...u, { playerId: p.id, startMs: matchMs, endMs: null }])
                              lastLocalWriteAt.current = performance.now()
                              await sb.from('playing_interval').insert({ match_id: matchId!, player_id: p.id, start_ms: Math.floor(matchMs) })
                            }}
                          >
                            Send on now
                          </button>
                        ) : (
                          <button
                            onClick={()=>setSelectedBenchIds(ids=>ids.includes(p.id)?ids.filter(x=>x!==p.id):[...ids,p.id])}
                            className="btn btn-ghost"
                          >
                            {selected ? 'Selected' : 'Mark ON'}
                          </button>
                        )}

                        {p.guest && (
                          <button
                            className="btn btn-ghost"
                            disabled={onFieldIdSet.has(p.id)}
                            title={onFieldIdSet.has(p.id) ? 'Sub off before removing guest' : 'Remove guest'}
                            onClick={async () => {
                              lastLocalWriteAt.current = performance.now()
                              await sb.from('match_player').delete().eq('match_id', matchId!).eq('player_id', p.id)
                              setGuests(gs => gs.filter(id => id !== p.id))
                              // also drop from availability
                              setAvailableIds(prev => {
                                const next = new Set(prev); next.delete(p.id)
                                localStorage.setItem(keyForAvail(matchId), JSON.stringify(Array.from(next)))
                                return next
                              })
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