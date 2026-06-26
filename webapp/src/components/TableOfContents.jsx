import { useState, useEffect } from 'react'

export default function TableOfContents({ headings }) {
  const [activeId, setActiveId] = useState('')

  useEffect(() => {
    if (!headings || headings.length === 0) return

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id)
          }
        }
      },
      { rootMargin: '-80px 0px -70% 0px' }
    )

    headings.forEach(({ id }) => {
      const el = document.getElementById(id)
      if (el) observer.observe(el)
    })

    return () => observer.disconnect()
  }, [headings])

  if (!headings || headings.length === 0) {
    return <aside className="toc-aside" />
  }

  return (
    <aside className="toc-aside">
      <div className="toc-header">On this page</div>
      <nav className="toc-nav">
        {headings.map(({ id, text, level }) => (
          <a
            key={id}
            href={`#${id}`}
            onClick={(e) => {
              e.preventDefault()
              const el = document.getElementById(id)
              if (el) el.scrollIntoView({ behavior: 'smooth' })
            }}
            className={`toc-link ${level === 3 ? 'toc-link--nested' : ''} ${activeId === id ? 'toc-link--active' : ''}`}
          >
            {text}
          </a>
        ))}
      </nav>
    </aside>
  )
}
