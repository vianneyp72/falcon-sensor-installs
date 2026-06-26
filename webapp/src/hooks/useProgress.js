import { useState, useCallback, useMemo } from 'react'
import { getAllLabs, getLabContent } from '../content/manifest'

const STORAGE_KEY = 'falcon-lab-progress'

function loadProgress() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
  } catch {
    return {}
  }
}

function saveProgress(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
}

// Count checkboxes in markdown content
function countCheckboxes(content) {
  if (!content) return 0
  const matches = content.match(/- \[ \]/g)
  return matches ? matches.length : 0
}

export function useProgress() {
  const [progress, setProgress] = useState(loadProgress)

  const isChecked = useCallback((key) => {
    return !!progress[key]
  }, [progress])

  const toggleCheckbox = useCallback((key) => {
    setProgress(prev => {
      const next = { ...prev, [key]: !prev[key] }
      if (!next[key]) delete next[key]
      saveProgress(next)
      return next
    })
  }, [])

  const getPageProgress = useCallback((labKey, activeMode, hasMode) => {
    const prefix = hasMode ? `${labKey}:${activeMode}:` : `${labKey}:`
    const checked = Object.keys(progress).filter(k => k.startsWith(prefix) && progress[k]).length
    const content = getLabContent(labKey)
    const total = countCheckboxes(content)
    return { checked, total }
  }, [progress])

  const { totalChecked, totalCheckboxes } = useMemo(() => {
    const labs = getAllLabs()
    let totalCheckboxes = 0
    let totalChecked = 0

    for (const lab of labs) {
      const content = getLabContent(lab.fullRoute)
      totalCheckboxes += countCheckboxes(content)
    }

    totalChecked = Object.values(progress).filter(Boolean).length
    return { totalChecked, totalCheckboxes }
  }, [progress])

  const reset = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY)
    setProgress({})
  }, [])

  return {
    isChecked,
    toggleCheckbox,
    getPageProgress,
    totalChecked,
    totalCheckboxes,
    reset,
  }
}
