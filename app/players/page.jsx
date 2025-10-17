'use client'
import { useEffect, useState } from 'react'
import { supabaseBrowser } from '../../lib/supabase-browser'

const DEFAULT_COUNT = 14

export default function PlayersPage() {
  const sb = supabaseBrowser()
  const [teams, setTeams] = useState([])
  const [teamId, setTeamId] = useState(null)
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [count, setCount] = useState(DEFAULT_COUNT)
  const [msg, setMsg] = useState('')

  useEffect(() => { (async () => {
    const { data: t } = await sb.from('team').select('id,name,squad,preferred_roster_size').order('squad')
    setTeams(t || [])
    setTeamId(t?.[0]?.id || null)
  })() }, [])

  useEffect(() => { if (teamId) load(teamId) }, [teamId])

  const load = async (tid) => {
    setLoading(true)
    const { data } = await sb
      .from('player')
      .select('id, display_name, initials, shirt_number, ext_id, team_id')
      .eq('team_id', tid)
      .order('shirt_number', { nullsFirst: true })
    let list = data ?? []
    if (!list.length) {
      list = Array.from({ length: DEFAULT_COUNT }, (_, i) => ({
        id: null,
        display_name: '',
        initials: `P${i+1}`,
        shirt_number: i + 1,
        ext_id: `p${i+1}`,
        team_id: tid,
      }))
    }
    setRows(list)
    const team = teams.find(t => t.id === tid)
    const pref = team?.preferred_roster_size ?? DEFAULT_COUNT
    setCount(Math.max(list.length, pref, DEFAULT_COUNT))
    setLoading(false)
  }

  const setRow = (i, patch) => {
    setRows(r => r.map((x, idx) => idx === i ? { ...x, ...patch } : x))
  }

  const ensureCount = (n) => {
    setRows(r => {
      const copy = [...r]
      while (copy.length < n) {
        const i = copy.length
        copy.push({
          id: null,
          display_name: '',
          initials: `P${i+1}`,
          shirt_number: i + 1,
          ext_id: `p${i+1}`,
          team_id: teamId,
        })
      }
      return copy.slice(0, n)
    })
    setCount(n)
  }

  const save = async () => {
    setSaving(true); setMsg('')
    for (const row of rows) {
      const payload = {
        team_id: teamId,
        display_name: (row.display_name || '').trim(),
        initials: (row.initials || '').trim() || null,
        shirt_number: row.shirt_number ?? null,
        ext_id: row.ext_id ?? null,
      }
      if (row.id) {
        const { error } = await sb.from('player').update(payload).eq('id', row.id)
        if (error) console.error(error)
      } else {
        const { data, error } = await sb.from('player').insert(payload).select('id').single()
        if (!error && data?.id) row.id = data.id
        if (error) console.error(error)
      }
    }
	await sb.from('team').update({ preferred_roster_size: count }).eq('id', teamId)
    setSaving(false); setMsg('Saved ✔')
    setTimeout(() => setMsg(''), 2000)
  }

  return (
    <div className="space-y-4">
      {/* Header row */}
		<div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
		  <div className="min-w-0">
			<h1 className="text-xl font-bold tracking-tight">Players</h1>
			<p className="text-sm text-gray-500 truncate">Name your squad. These names appear on the match console.</p>
		  </div>
		  <div className="flex flex-wrap gap-2">
			<select value={teamId || ''} onChange={e => setTeamId(e.target.value)} className="field field-dark w-[calc(50%-0.25rem)] sm:w-auto">
			  {teams.map(t => <option key={t.id} value={t.id}>{t.name} — {t.squad.toUpperCase()}</option>)}
			</select>

			<label className="text-sm flex items-center gap-2 w-[calc(50%-0.25rem)] sm:w-auto">
			  Squad size
			  <select value={count} onChange={e => ensureCount(parseInt(e.target.value))} className="field field-dark w-full sm:w-[92px]">
				{[10,11,12,13,14,15,16,17,18,19,20].map(n => <option key={n} value={n}>{n}</option>)}
			  </select>
			</label>

			<button onClick={save} disabled={saving} className={`btn ${saving ? 'btn-ghost text-gray-400' : 'btn-primary'} w-full sm:w-auto`}>
			  {saving ? 'Saving…' : 'Save'}
			</button>
		  </div>
		</div>

      {/* Grid */}
      <div className="card card-narrow">
        {loading ? (
          <div className="text-sm text-gray-500">Loading…</div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {rows.map((r, i) => (
              <div key={i} className="rounded-3xl border border-black/5 dark:border-white/10 bg-[var(--surface)] p-4 shadow-soft">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-xs text-gray-500">#{r.shirt_number ?? (i+1)}</div>
                  <div className="chip chip-muted">Player {i+1}</div>
                </div>

                <label className="block text-sm mb-2">
                  <span className="text-gray-500">Name</span>
                  <input
                    value={r.display_name ?? ''}
                    onChange={e => setRow(i, { display_name: e.target.value })}
                    className="field field-dark mt-1"
                    placeholder={`Player ${i+1} name`}
                  />
                </label>

                <div className="grid grid-cols-2 gap-2">
                  <label className="block text-sm">
                    <span className="text-gray-500">Initials</span>
                    <input
                      value={r.initials ?? ''}
                      onChange={e => setRow(i, { initials: e.target.value })}
                      className="field field-dark mt-1"
                      placeholder="AB"
                    />
                  </label>
                  <label className="block text-sm">
                    <span className="text-gray-500">Shirt #</span>
                    <input
                      type="number"
                      value={r.shirt_number ?? ''}
                      onChange={e => setRow(i, { shirt_number: parseInt(e.target.value || '0') || null })}
                      className="field field-dark mt-1"
                      placeholder="10"
                    />
                  </label>
                </div>
				{/* Move to squad (permanent transfer) */}
				<div className="mt-2">
				  <label className="block text-xs text-gray-500 mb-1">Move to squad</label>
				  <select
					className="field field-dark"
					value={r.team_id ?? teamId} // show the player's current squad
					onChange={async (e) => {
					  const newTeamId = e.target.value
					  if (!r.id) {
						alert('Save this player first, then you can move them.')
						return
					  }
					  if (newTeamId === (r.team_id ?? teamId)) return
					  const { error } = await sb.from('player').update({ team_id: newTeamId }).eq('id', r.id)
					  if (!error) {
						// Optimistically update local row and, if moved away from current squad, remove from view
						setRows(rows => rows.filter(x => x.id !== r.id))
					  } else {
						console.error(error)
					  }
					}}
					disabled={!r.id} // disable for unsaved placeholder rows
				  >
					{teams.map(t => (
					  <option key={t.id} value={t.id}>{t.name} — {t.squad.toUpperCase()}</option>
					))}
				  </select>
				  <p className="mt-1 text-[11px] text-gray-500">
					Past games stay with the original squad; this affects future games.
				  </p>
				</div>				
              </div>
            ))}
          </div>
        )}
      </div>

      {!!msg && <div className="text-sm text-emerald-700">{msg}</div>}
    </div>
  )
}
