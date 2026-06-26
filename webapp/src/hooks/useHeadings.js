import { useState, useEffect } from 'react'

export function useHeadings(contentRef, content, activeMode) {
  const [headings, setHeadings] = useState([])

  useEffect(() => {
    // Wait for render
    const timer = setTimeout(() => {
      if (!contentRef.current) return
      const els = contentRef.current.querySelectorAll('h2, h3')
      const items = Array.from(els)
        .filter(el => {
          // Exclude headings inside hidden mode blocks
          const parent = el.closest('.mode-content--hidden')
          return !parent
        })
        .map(el => ({
          id: el.id,
          text: el.textContent,
          level: parseInt(el.tagName[1]),
        })).filter(h => h.id)
      setHeadings(items)
    }, 100)

    return () => clearTimeout(timer)
  }, [content, contentRef, activeMode])

  return headings
}
