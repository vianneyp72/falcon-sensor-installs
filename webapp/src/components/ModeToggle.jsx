import { useEffect, useState } from 'react'

const STORAGE_KEY = 'falcon-lab-mode'

export default function ModeToggle({ activeMode, setActiveMode }) {
  return (
    <div className="mode-toggle-wrapper">
      <span className="mode-toggle-wrapper__label">Choose your path</span>
      <div className="mode-toggle">
        <button
          className={`mode-toggle__tab ${activeMode === 'guide' ? 'mode-toggle__tab--active' : ''}`}
          onClick={() => {
            setActiveMode('guide')
            localStorage.setItem(STORAGE_KEY, 'guide')
          }}
        >
          Quick Deploy
        </button>
        <button
          className={`mode-toggle__tab ${activeMode === 'lab' ? 'mode-toggle__tab--active' : ''}`}
          onClick={() => {
            setActiveMode('lab')
            localStorage.setItem(STORAGE_KEY, 'lab')
          }}
        >
          Full Lab
        </button>
      </div>
    </div>
  )
}

export function useModeToggle() {
  const [activeMode, setActiveMode] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) || 'guide'
    } catch {
      return 'guide'
    }
  })
  return [activeMode, setActiveMode]
}

export function contentHasMode(content) {
  return content && /data-mode=/.test(content)
}
