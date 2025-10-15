'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { supabaseBrowser } from '../../lib/supabase-browser'

/* ---------- helpers ---------- */
const fmt = (ms) => {
  const s = Math.floor(ms / 1000)
  const mm = Math.floor(s / 60)
  const ss = s % 60
  return `${mm.toString().padStart(2,'0')}:${ss.toString().padStart(2,'0')}`
}

const makeRoster = (count = 14) =>
  Array.from({ length: count }, (_, i) => ({ id: `p${i + 1}`, name: `${i + 1}. Player` }))

/**
 * Step 1 (dev):
 * - Creates a match (saved in localStorage)
 * - Persists playing intervals + TRY/TACKLE/OTHER + SUB events
 * - Subscribes to realtime changes and refreshes
 * - Clock is local-only (authority/hand-off comes in Step 2)
 */
export default function MatchConsole() {
  const [dark, setDark] = useState(false)
  const [teamName] = useState('Mighty Knights')
  const [opponent, setOpponent] = useState('Opposition U9')
  const [halfLengthMin, setHalfLengthMin] = useState(10)
  const [maxOnField, setMaxOnField] = useState(8)

  const [isRunning, setIsRunning] = useState(false)
  const [matchMs, setMatchMs] = useState(0)
  const lastTickRef = useRef(null)

  const [players, setPlayers] = useState(makeRoster(14))
  const [intervals, setIntervals] = useState([]) // {playerId, startMs, endMs|null}[]
  const [events, setEvents] = useState([])       // {type, atMs, playerId?, note?}[]
  const [history, setHistory] = useState([])

  const [lockUntilHT, setLockUntilHT] = useState({})
  const [startAtHT, setStartAtHT] = useState({})

  const [selectedBenchIds, setSelectedBenchIds] = useState([])
  const [selectedOnIds, setSelectedOnIds] = useState([])
  const [noteDraft, setNoteDraft] = useState('')

  const halftimeMs = halfLengthMin * 60 * 1000
  const supabase = supabaseBrowser()

  const [matchId, setMatchId] = useState(null)

  /* ---------- bootstrap match row ---------- */
  useEffect(() => {
    const boot = async () => {
      let mid = typeof window !== 'undefined' ? localStorage.getItem('mk_match_id') : null
      if (!mid) {
        const { data, error } = await supabase
          .from('match')
          .insert({
            opponent,
            half_length_minutes: halfLengthMin,
            max_on_field: maxOnField,
          })
          .select('id')
          .single()
        if (error) {
          console.error('create match', error)
          return
        }
        mid = data.id
        localStorage.setItem('mk_match_id', mid)
      }
      setMatchId(mid)
    }
    boot()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ---------- seed starters, subscribe to realtime, pull latest ---------- */
  useEffect(() => {
    if (!matchId) return

    const init = async () => {
      const { data: existing } = await supabase
        .from('playing_interval')
        .select('id')
        .eq('match_id', matchId)
        .limit(1)

      if (!existing || existing.length === 0) {
        const starters = players
          .slice(0, maxOnField)
          .map((p) => ({ match_id: matchId, player_id: p.id, start_ms: 0 }))
        await supabase.from('playing_interval').insert(starters)
      }

      await refreshFromDb(matchId)

      const channel = supabase
        .channel(`match:${matchId}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'playing_interval', filter: `match_id=eq.${matchId}` },
          () => refreshFromDb(matchId)
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'event', filter: `match_id=eq.${matchId}` },
          () => refreshFromDb(matchId)
        )
        .subscribe()

      return () => supabase.removeChannel(channel)
    }

    const cleanupPromise = init()
    return () => {
      // ensure unsubscribe if init returned a cleanup
      if (cleanupPromise && typeof cleanupPromise === 'function') cleanupPromise()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchId])

  const refreshFromDb = async (mid) => {
    const [{ data: pis }, { data: evs }] = await Promise.all([
      supabase.from('playing_interval').select('*').eq('match_id', mid).order('start_ms'),
      supabase.from('event').select('*').eq('match_id', mid).order('at_ms'),
    ])
    if (pis) {
      setIntervals(
        pis.map((r) => ({ playerId: r.player_id, startMs: r.start_ms, endMs: r.end_ms ?? null }))
      )
    }
    if (evs) {
      setEvents(
        evs.map((e) => ({
          type: e.kind === 'SUB' ? 'SUB_BATCH' : e.kind,
          atMs: e.at_ms,
          playerId: e.player_id ?? undefined,
          note: e.note ?? undefined,
        }))
      )
    }
  }

  /* ---------- local clock ---------- */
  useEffect(() => {
    if (!isRunning) {
      lastTickRef.current = null
      return
    }
    let raf = 0
    const loop = () => {
      const t = performance.now()
      if (lastTickRef.current == null) lastTickRef.current = t
      const dt = t - lastTickRef.current
      lastTickRef.current = t
      setMatchMs((m) => m + dt)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [isRunning])

  /* ---------- derived ---------- */
  const isOnField = (pid) => intervals.some((i) => i.playerId === pid && i.endMs == null)
  const onField = useMemo(() => players.filter((p) => isOnField(p.id)), [players, intervals])
  const bench = useMemo(() => players.filter((p) => !isOnField(p.id)), [players, intervals])

  const minutesByPlayer = useMemo(() => {
    const map = new Map()
    for (const i of intervals) {
      const end = i.endMs ?? matchMs
      const dur = Math.max(0, end - i.startMs)
      map.set(i.playerId, (map.get(i.playerId) ?? 0) + dur)
    }
    return map
  }, [intervals, matchMs])

  const totalFieldTimeMs = matchMs * maxOnField
  const fairShareMs = players.length > 0 ? totalFieldTimeMs / players.length : 0
  const fullGameMs = halfLengthMin * 2 * 60 * 1000
  const fullTimeTargetMs = players.length > 0 ? (fullGameMs * maxOnField) / players.length : 0

  /* ---------- actions ---------- */
  const snapshot = () =>
    setHistory((h) => [
      ...h,
      {
        intervals: JSON.parse(JSON.stringify(intervals)),
        events: JSON.parse(JSON.stringify(events)),
        matchMs,
        isRunning,
        maxOnField,
      },
    ])

  const toggleClock = () => {
    snapshot()
    setIsRunning((v) => !v)
  }

  const persistBatchSub = async (pairs) => {
    if (!matchId) return
    // close OFF intervals
    for (const { offId } of pairs) {
      await supabase
        .from('playing_interval')
        .update({ end_ms: Math.floor(matchMs) })
        .eq('match_id', matchId)
        .eq('player_id', offId)
        .is('end_ms', null)
    }
    // open ON intervals
    for (const { onId } of pairs) {
      await supabase
        .from('playing_interval')
        .insert({ match_id: matchId, player_id: onId, start_ms: Math.floor(matchMs) })
    }
    // log SUB event with payload
    await supabase
      .from('event')
      .insert({ match_id: matchId, kind: 'SUB', at_ms: Math.floor(matchMs), note: JSON.stringify(pairs) })
  }

  const doBatchSub = async () => {
    if (!selectedBenchIds.length || !selectedOnIds.length) return
    const n = Math.min(selectedBenchIds.length, selectedOnIds.length)
    const pairs = Array.from({ length: n }, (_, i) => ({ onId: selectedBenchIds[i], offId: selectedOnIds[i] }))

    snapshot()
    // Local optimistic update
    setIntervals((list) => {
      let updated = [...list]
      for (const { offId, onId } of pairs) {
        if (!isOnField(offId) || isOnField(onId)) continue
        const idx = updated.findIndex((it) => it.playerId === offId && it.endMs == null)
        if (idx >= 0) updated = updated.map((it, k) => (k === idx ? { ...it, endMs: matchMs } : it))
        updated.push({ playerId: onId, startMs: matchMs })
      }
      return updated
    })
    setEvents((e) => [...e, { type: 'SUB_BATCH', atMs: matchMs, pairs }])
    setSelectedBenchIds([])
    setSelectedOnIds([])

    // Persist to DB (realtime will refresh others)
    await persistBatchSub(pairs)
  }

  const suggestNow = () => {
    const beforeHT = matchMs < halftimeMs
    const eligibleOff = onField.filter((p) => !(beforeHT && lockUntilHT[p.id]))
    const eligibleOn = bench.filter((p) => !(beforeHT && startAtHT[p.id]))

    const surplus = (pid) => (minutesByPlayer.get(pid) ?? 0) - fullTimeTargetMs
    const deficit = (pid) => fullTimeTargetMs - (minutesByPlayer.get(pid) ?? 0)

    const offSorted = [...eligibleOff].sort((a, b) => surplus(b.id) - surplus(a.id))
    const onSorted = [...eligibleOn].sort((a, b) => deficit(b.id) - deficit(a.id))

    const n = Math.min(offSorted.length, onSorted.length, maxOnField)
    setSelectedOnIds(offSorted.slice(0, n).map((p) => p.id))
    setSelectedBenchIds(onSorted.slice(0, n).map((p) => p.id))
  }

  const quickAction = async (kind, playerId) => {
    setEvents((e) => [
      ...e,
      { type: kind, atMs: matchMs, playerId, note: kind === 'OTHER' ? noteDraft || undefined : undefined },
    ])
    if (kind === 'OTHER') setNoteDraft('')
    if (!matchId) return
    const dbKind = kind === 'TRY' || kind === 'TACKLE' || kind === 'OTHER' ? kind : 'OTHER'
    await supabase.from('event').insert({
      match_id: matchId,
      player_id: playerId ?? null,
      at_ms: Math.floor(matchMs),
      kind: dbKind,
      note: kind === 'OTHER' ? noteDraft || null : null,
    })
  }

  const undo = () => {
    const prev = history[history.length - 1]
    if (!prev) return
    setIntervals(prev.intervals)
    setEvents(prev.events)
    setMatchMs(prev.matchMs)
    setIsRunning(false)
    setSelectedBenchIds([])
    setSelectedOnIds([])
    setHistory((h) => h.slice(0, -1))
    // Step 1: undo is local only
  }

  /* ---------- UI ---------- */
  return (
    <div className={dark ? 'dark' : ''}>
      <div className="space-y-4">
        {/* Header */}
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src="/mk-logo.png" alt="Mighty Knights" className="h-10 w-10 rounded-xl" />
            <div>
              <div className="text-xl font-bold">{teamName} — Match Console</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">vs {opponent}</div>
              {matchId && <div className="text-[10px] text-gray-400">Match ID: {matchId.slice(0, 8)}…</div>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setDark((d) => !d)} className="rounded-xl border px-3 py-2 text-sm shadow">
              {dark ? 'Light' : 'Dark'} mode
            </button>
            <button onClick={undo} className="rounded-xl border px-3 py-2 text-sm shadow">
              Undo
            </button>
          </div>
        </div>

        {/* Clock + Settings */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="rounded-3xl border p-4 shadow md:col-span-2">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-gray-500">Match Clock</div>
                <div className="text-6xl font-extrabold tabular-nums">{fmt(matchMs)}</div>
                <div className="text-xs text-gray-500">
                  Half length: {halfLengthMin}′ • On field: {onField.length}/{maxOnField}
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={toggleClock}
                  className={`rounded-2xl px-4 py-3 text-white shadow ${
                    isRunning ? 'bg-red-600' : 'bg-green-600'
                  }`}
                >
                  {isRunning ? 'Pause' : 'Start'}
                </button>
              </div>
            </div>
          </div>

          <div className="rounded-3xl border p-4 shadow">
            <div className="mb-2 text-sm font-semibold">Match Settings</div>
            <label className="mb-2 block text-sm">
              Team size (a-side)
              <select
                value={maxOnField}
                onChange={(e) => setMaxOnField(parseInt(e.target.value))}
                className="mt-1 w-full rounded-xl border px-3 py-2"
              >
                {[6, 7, 8, 9, 10].map((v) => (
                  <option key={v} value={v}>
                    {v} a-side
                  </option>
                ))}
              </select>
            </label>
            <label className="mb-2 block text-sm">
              Half length
              <select
                value={halfLengthMin}
                onChange={(e) => setHalfLengthMin(parseInt(e.target.value))}
                className="mt-1 w-full rounded-xl border px-3 py-2"
              >
                {Array.from({ length: 8 }, (_, i) => i + 8).map((v) => (
                  <option key={v} value={v}>
                    {v} minutes
                  </option>
                ))}
              </select>
            </label>
            <label className="mb-2 block text-sm">
              Opponent
              <input
                value={opponent}
                onChange={(e) => setOpponent(e.target.value)}
                className="mt-1 w-full rounded-xl border px-3 py-2"
              />
            </label>
            <label className="mb-2 block text-sm">
              Squad size
              <select
                onChange={(e) => setPlayers(makeRoster(parseInt(e.target.value)))}
                className="mt-1 w-full rounded-xl border px-3 py-2"
                defaultValue={players.length}
              >
                {[10, 12, 14, 16, 18].map((v) => (
                  <option key={v} value={v}>
                    {v} players
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {/* On Field */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="rounded-3xl border p-4 shadow lg:col-span-2">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-lg font-semibold">On Field ({onField.length}/{maxOnField})</h2>
              {selectedBenchIds.length > 0 && (
                <span className="text-xs text-blue-600">Select {selectedBenchIds.length} to sub OFF</span>
              )}
            </div>
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
              {onField.map((p) => {
                const played = minutesByPlayer.get(p.id) ?? 0
                const selected = selectedOnIds.includes(p.id)
                const beforeHT = matchMs < halftimeMs
                const locked = !!lockUntilHT[p.id] && beforeHT
                const diff = played - fairShareMs
                return (
                  <li key={p.id} className={`rounded-2xl border px-3 py-2 ${selected ? 'ring-2 ring-blue-500' : ''}`}>
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-medium">{p.name}</div>
                        <div className="text-xs text-gray-500">⏱ {fmt(played)} • tgt {fmt(fairShareMs)}</div>
                        <div
                          className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] tabular-nums ${
                            diff >= 60000
                              ? 'bg-red-50 text-red-700'
                              : diff <= -60000
                              ? 'bg-green-50 text-green-700'
                              : 'bg-gray-100 text-gray-600'
                          }`}
                        >
                          {(diff >= 0 ? '+' : '-') + fmt(Math.abs(diff))}
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <button
                          onClick={() =>
                            !locked &&
                            setSelectedOnIds((ids) => (ids.includes(p.id) ? ids.filter((x) => x !== p.id) : [...ids, p.id]))
                          }
                          className={`rounded-xl px-3 py-1 text-sm ${
                            locked ? 'bg-gray-200 text-gray-400' : 'bg-gray-100'
                          }`}
                          title={locked ? 'Locked until halftime' : 'Mark to sub OFF'}
                        >
                          {locked ? 'Locked' : selected ? 'Selected' : 'Mark OFF'}
                        </button>
                        <div className="flex gap-1">
                          <button
                            onClick={() => quickAction('TRY', p.id)}
                            className="rounded-lg bg-emerald-600 text-white px-2 py-1 text-[11px]"
                          >
                            Try
                          </button>
                          <button
                            onClick={() => quickAction('TACKLE', p.id)}
                            className="rounded-lg bg-indigo-600 text-white px-2 py-1 text-[11px]"
                          >
                            Tackle
                          </button>
                          <button
                            onClick={() => {
                              setNoteDraft(p.name + ': ')
                              quickAction('OTHER', p.id)
                            }}
                            className="rounded-lg bg-gray-800 text-white px-2 py-1 text-[11px]"
                          >
                            Other
                          </button>
                        </div>
                        <label className="mt-1 flex items-center gap-1 text-[11px] text-gray-600">
                          <input
                            type="checkbox"
                            checked={!!lockUntilHT[p.id]}
                            onChange={(e) => setLockUntilHT((prev) => ({ ...prev, [p.id]: e.target.checked }))}
                          />{' '}
                          Lock until HT
                        </label>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>

          {/* Bench */}
          <div className="rounded-3xl border p-4 shadow">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Bench</h2>
              {selectedOnIds.length > 0 && (
                <span className="text-xs text-blue-600">Select {selectedOnIds.length} to come ON</span>
              )}
            </div>
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {bench.map((p) => {
                const selected = selectedBenchIds.includes(p.id)
                const beforeHT = matchMs < halftimeMs
                const heldForHT = !!startAtHT[p.id] && beforeHT
                const played = minutesByPlayer.get(p.id) ?? 0
                const diff = played - fairShareMs
                return (
                  <li key={p.id}>
                    <div
                      className={`w-full rounded-2xl border px-3 py-2 text-left shadow ${
                        selected ? 'ring-2 ring-blue-500' : ''
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="font-medium">{p.name}</div>
                          <div className="text-xs text-gray-500">⏱ {fmt(played)} • tgt {fmt(fairShareMs)}</div>
                          <div
                            className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] tabular-nums ${
                              diff >= 60000
                                ? 'bg-red-50 text-red-700'
                                : diff <= -60000
                                ? 'bg-green-50 text-green-700'
                                : 'bg-gray-100 text-gray-600'
                            }`}
                          >
                            {(diff >= 0 ? '+' : '-') + fmt(Math.abs(diff))}
                          </div>
                        </div>
                        <button
                          onClick={() =>
                            !heldForHT &&
                            setSelectedBenchIds((ids) => (ids.includes(p.id) ? ids.filter((x) => x !== p.id) : [...ids, p.id]))
                          }
                          className={`rounded-xl px-3 py-1 text-sm ${
                            heldForHT ? 'bg-gray-200 text-gray-400' : 'bg-gray-100'
                          }`}
                          title={heldForHT ? 'Will start at halftime' : 'Mark to come ON'}
                        >
                          {heldForHT ? 'Hold for HT' : selected ? 'Selected' : 'Mark ON'}
                        </button>
                      </div>
                      <label className="mt-1 flex items-center gap-1 text-[11px] text-gray-600">
                        <input
                          type="checkbox"
                          checked={!!startAtHT[p.id]}
                          onChange={(e) => setStartAtHT((prev) => ({ ...prev, [p.id]: e.target.checked }))}
                        />{' '}
                        Start at HT
                      </label>
                    </div>
                  </li>
                )
              })}
            </ul>

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                onClick={suggestNow}
                className="rounded-xl px-3 py-2 text-sm shadow bg-blue-50 text-blue-700 border border-blue-200"
              >
                Suggest rotation (now)
              </button>
              <button
                onClick={doBatchSub}
                disabled={
                  !selectedBenchIds.length ||
                  !selectedOnIds.length ||
                  selectedBenchIds.length !== selectedOnIds.length
                }
                className={`rounded-xl px-3 py-2 text-sm shadow ${
                  selectedBenchIds.length > 0 &&
                  selectedOnIds.length > 0 &&
                  selectedBenchIds.length === selectedOnIds.length
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-400'
                }`}
              >
                Confirm batch ({selectedBenchIds.length})
              </button>
              <button
                onClick={() => {
                  setSelectedBenchIds([])
                  setSelectedOnIds([])
                }}
                className="rounded-xl border px-3 py-2 text-sm shadow"
              >
                Clear
              </button>
            </div>
          </div>
        </div>

        {/* Minutes grid + Quick Actions + Event Log */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="rounded-3xl border p-4 shadow lg:col-span-2">
            <h3 className="mb-2 text-lg font-semibold">
              Minutes — now {fmt(fairShareMs)} • full-time {fmt(fullTimeTargetMs)}
            </h3>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
              {players.map((p) => {
                const played = minutesByPlayer.get(p.id) ?? 0
                const diffNow = played - fairShareMs
                const diffFT = played - fullTimeTargetMs
                return (
                  <div key={p.id} className="rounded-2xl border px-3 py-2">
                    <div className="text-sm">{p.name}</div>
                    <div className="text-xs text-gray-500">⏱ {fmt(played)}</div>
                    <div
                      className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] tabular-nums ${
                        diffNow >= 60000
                          ? 'bg-red-50 text-red-700'
                          : diffNow <= -60000
                          ? 'bg-green-50 text-green-700'
                          : 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      now {(diffNow >= 0 ? '+' : '-') + fmt(Math.abs(diffNow))}
                    </div>
                    <div
                      className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] tabular-nums ${
                        diffFT >= 60000
                          ? 'bg-orange-50 text-orange-700'
                          : diffFT <= -60000
                          ? 'bg-teal-50 text-teal-700'
                          : 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      FT {(diffFT >= 0 ? '+' : '-') + fmt(Math.abs(diffFT))}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="rounded-3xl border p-4 shadow">
            <h3 className="mb-3 text-lg font-semibold">Quick Actions</h3>
            <div className="mb-3 grid grid-cols-3 gap-2">
              <button
                onClick={() => quickAction('TRY')}
                className="rounded-xl px-3 py-2 text-sm shadow bg-emerald-600 text-white"
              >
                Log Try (no player)
              </button>
              <button
                onClick={() => quickAction('TACKLE')}
                className="rounded-xl px-3 py-2 text-sm shadow bg-indigo-600 text-white"
              >
                Log Tackle (no player)
              </button>
              <button
                onClick={() => quickAction('OTHER')}
                className="rounded-xl px-3 py-2 text-sm shadow bg-gray-800 text-white"
              >
                Other (note)
              </button>
            </div>
            <input
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder="Optional note for Other"
              className="mb-3 w-full rounded-xl border px-3 py-2"
            />

            <h3 className="mb-2 text-lg font-semibold">Event Log</h3>
            <ul className="space-y-2 max-h-80 overflow-auto pr-1">
              {events.map((ev, idx) => (
                <li
                  key={idx}
                  className="rounded-xl border px-3 py-2 text-sm flex items-center justify-between"
                >
                  <span>
                    {ev.type === 'SUB_BATCH' ? (
                      <>
                        <span className="inline-block rounded bg-blue-50 px-2 py-0.5 text-blue-700 mr-2 text-xs">
                          SUB×{(ev.pairs?.length ?? 0)}
                        </span>
                        {ev.pairs?.map((p, i) => (
                          <span key={i} className="mr-1">
                            {p.onId}↔{p.offId}
                          </span>
                        ))}
                      </>
                    ) : ev.type === 'TRY' || ev.type === 'TACKLE' || ev.type === 'OTHER' ? (
                      <>
                        <span className="inline-block rounded bg-emerald-50 px-2 py-0.5 text-emerald-700 mr-2 text-xs">
                          {ev.type}
                        </span>
                        {ev.playerId ? `${ev.playerId}` : '(no player)'}
                        {ev.note ? ` — ${ev.note}` : ''}
                      </>
                    ) : (
                      <>
                        <span className="inline-block rounded bg-gray-50 px-2 py-0.5 text-gray-700 mr-2 text-xs">
                          {ev.type}
                        </span>
                        {ev.type === 'START'
                          ? 'Match created'
                          : ev.type === 'PAUSE'
                          ? 'Clock paused'
                          : 'Clock resumed'}
                      </>
                    )}
                  </span>
                  <span className="tabular-nums text-xs text-gray-500">{fmt(ev.atMs ?? 0)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}
