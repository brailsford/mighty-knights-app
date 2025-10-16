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
    const { data: t } = await sb.from('team').select('id,name,squad').order('squad')
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
        id: null, display_name: '', initials: `P${i+1}`, shirt_number: i+1, ext_id: `p${i+1}`, team_id: tid
      }))
    }
    setRows(list); setCount(Math.max(list.length, DEFAULT_COUNT)); setLoading(false)
  }

  const setRow = (i, patch) => setRows(r => r.map((x, idx) => idx === i ? { ...x, ...patch } : x))

  const ensureCount = (n) => {
    setRows(r => {
      const copy = [...r]
      while (copy.length < n) {
        const i = copy.length
        copy.push({ id: null, display_name: '', initials: `P${i+1}`, shirt_number: i+1, ext_id: `p${i+1}`, team_id: teamId })
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
        display_name: (row.display_name||'').trim(),
        initials: (row.initials||'').trim() || null,
        shirt_number: row.shirt_number ?? null,
        ext_id: row.ext_id ?? null,
      }
      if (row.id) {
        await sb.from('player').update(payload).eq('id', row.id)
      } else {
        const { data } = await sb.from('player').insert(payload).select('id').single()
        if (data?.id) row.id = data.id
      }
    }
    setSaving(false); setMsg('Saved ✔')
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Players</h1>
          <p className="text-sm text-gray-500">Name your squad. These names appear on the match console.</p>
        </div>
        <div className="flex items-center gap-2">
          <select value={teamId||''} onChange={e=>setTeamId(e.target.value)} className="rounded-xl border px-3 py-2">
            {teams.map(t => <option key={t.id} value={t.id}>{t.name} — {t.squad.toUpperCase()}</option>)}
          </select>
          <label className="text-sm">
            Squad size
            <select value={count} onChange={e => ensureCount(parseInt(e.target.value))} className="ml-2 rounded-xl border px-3 py-1">
              {[10,12,14,16,18,20].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <button onClick={save} disabled={saving}
            className={`rounded-xl px-3 py-2 text-sm shadow ${saving ? 'bg-gray-200' : 'bg-blue-600 text-white'}`}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {loading ? <div>Loading…</div> : (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
          {rows.map((r, i) => (
            <div key={i} className="rounded-2xl border p-3">
              <div className="text-xs text-gray-500 mb-1">#{r.shirt_number ?? (i+1)}</div>
              <input value={r.display_name ?? ''} onChange={e => setRow(i, { display_name: e.target.value })}
                className="w-full rounded-xl border px-3 py-2 mb-2" placeholder={`Player ${i+1} name`} />
              <div className="flex gap-2">
                <input value={r.initials ?? ''} onChange={e => setRow(i, { initials: e.target.value })}
                  className="w-1/2 rounded-xl border px-3 py-2" placeholder="Initials" />
                <input type="number" value={r.shirt_number ?? ''} onChange={e => setRow(i, { shirt_number: parseInt(e.target.value||'0')||null })}
                  className="w-1/2 rounded-xl border px-3 py-2" placeholder="Shirt #" />
              </div>
            </div>
          ))}
        </div>
      )}

      {!!msg && <div className="text-sm text-emerald-700">{msg}</div>}
    </div>
  )
}
