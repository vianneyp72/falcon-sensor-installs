import { useState, useEffect, useRef, useMemo } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import { getLabContent, getLabMeta } from '../content/manifest'
import { useProgress } from '../hooks/useProgress'
import { useHeadings } from '../hooks/useHeadings'
import TableOfContents from './TableOfContents'
import CodeBlock from './CodeBlock'
import FlowDiagram, { isAsciiDiagram } from './FlowDiagram'
import StatusBadge from './StatusBadge'
import ModeToggle, { useModeToggle, contentHasMode } from './ModeToggle'

export default function LabRenderer({ labKey }) {
  const content = getLabContent(labKey)
  const meta = getLabMeta(labKey)
  const contentRef = useRef(null)
  const { isChecked, toggleCheckbox, getPageProgress } = useProgress()
  const [activeMode, setActiveMode] = useModeToggle()
  const headings = useHeadings(contentRef, content, activeMode)
  const checkboxIndex = useRef(0)
  const hasMode = contentHasMode(content)

  // Reset checkbox index on each render
  checkboxIndex.current = 0

  const pageProgress = getPageProgress(labKey, activeMode, hasMode)

  if (!content || content.trim().length === 0) {
    return (
      <>
        <main className="content-area" ref={contentRef}>
          <h1>{meta?.label || 'Lab'}</h1>
          <StatusBadge status="empty" />
          <p style={{ marginTop: '1rem', color: 'var(--text-muted)' }}>
            This lab has not been written yet.
          </p>
        </main>
        <aside className="toc-aside" />
      </>
    )
  }

  if (meta?.status === 'stub') {
    return (
      <>
        <main className="content-area" ref={contentRef}>
          <StatusBadge status="stub" />
          <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>
            {content}
          </Markdown>
        </main>
        <aside className="toc-aside" />
      </>
    )
  }

  const components = {
    code({ node, inline, className, children, ...props }) {
      const match = /language-(\w+)/.exec(className || '')
      const content = String(children).replace(/\n$/, '')
      if (!inline && (match || content.includes('\n'))) {
        // Check if this is an ASCII diagram
        if (isAsciiDiagram(content)) {
          return <FlowDiagram content={content} />
        }
        return (
          <CodeBlock language={match ? match[1] : ''}>
            {content}
          </CodeBlock>
        )
      }
      return <code className={className} {...props}>{children}</code>
    },
    pre({ children }) {
      return <>{children}</>
    },
    div({ node, children, ...props }) {
      const dataMode = node?.properties?.dataMode
      if (dataMode) {
        if (dataMode !== activeMode) {
          return <div className="mode-content--hidden" />
        }
        return <div {...props}>{children}</div>
      }
      return <div {...props}>{children}</div>
    },
    input({ type, checked, disabled, node, ...props }) {
      if (type === 'checkbox') {
        const idx = checkboxIndex.current++
        const key = hasMode ? `${labKey}:${activeMode}:${idx}` : `${labKey}:${idx}`
        const isComplete = isChecked(key)
        return (
          <input
            type="checkbox"
            checked={isComplete}
            onChange={() => toggleCheckbox(key)}
          />
        )
      }
      return <input type={type} checked={checked} disabled={disabled} {...props} />
    },
    li({ node, children, className, ...props }) {
      // Check if this li contains a checkbox (task list item)
      const hasCheckbox = node?.properties?.className?.includes('task-list-item') ||
        (node?.children?.[0]?.tagName === 'input' ||
         (node?.children?.[0]?.type === 'element' && node?.children?.[0]?.tagName === 'p' &&
          node?.children?.[0]?.children?.[0]?.tagName === 'input'))

      if (hasCheckbox) {
        const idx = checkboxIndex.current // peek (input renderer will increment)
        const key = hasMode ? `${labKey}:${activeMode}:${idx}` : `${labKey}:${idx}`
        const isComplete = isChecked(key)
        return (
          <li className={`lab-checkbox ${isComplete ? 'checked' : ''}`} {...props}>
            {children}
          </li>
        )
      }
      return <li className={className} {...props}>{children}</li>
    },
    blockquote({ children, ...props }) {
      const text = getTextContent(children)
      let variant = 'info'
      if (/what\s*&\s*why|how this works/i.test(text)) variant = 'info'
      else if (/⚠️|warning|caution|important/i.test(text)) variant = 'warning'
      else if (/look for|verify|confirm|check/i.test(text)) variant = 'success'
      else if (/prerequisites|status|note/i.test(text)) variant = 'note'
      else if (/~\d+\s*min/i.test(text)) variant = 'time'
      return <blockquote className={`callout callout--${variant}`} {...props}>{children}</blockquote>
    },
    h1({ children, ...props }) {
      const id = slugify(children)
      return <h1 id={id} {...props}>{children}</h1>
    },
    h2({ children, ...props }) {
      const id = slugify(children)
      const text = typeof children === 'string' ? children : Array.isArray(children)
        ? children.map(c => (typeof c === 'string' ? c : '')).join('') : ''
      if (hasMode && /deployment steps/i.test(text)) {
        return (
          <>
            <ModeToggle activeMode={activeMode} setActiveMode={setActiveMode} />
            <h2 id={id} {...props}>{children}</h2>
          </>
        )
      }
      return <h2 id={id} {...props}>{children}</h2>
    },
    h3({ children, ...props }) {
      const id = slugify(children)
      return <h3 id={id} {...props}>{children}</h3>
    },
  }

  return (
    <>
      <main className="content-area" ref={contentRef}>
        {pageProgress.total > 0 && (
          <div className="progress-bar" style={{ marginBottom: '1.5rem' }}>
            <span>{pageProgress.checked}/{pageProgress.total} steps</span>
            <div className="progress-bar__track">
              <div
                className="progress-bar__fill"
                style={{ width: `${(pageProgress.checked / pageProgress.total) * 100}%` }}
              />
            </div>
          </div>
        )}
        <Markdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeRaw]}
          components={components}
        >
          {content}
        </Markdown>
      </main>
      <TableOfContents headings={headings} />
    </>
  )
}

function slugify(children) {
  const text = typeof children === 'string'
    ? children
    : Array.isArray(children)
      ? children.map(c => (typeof c === 'string' ? c : c?.props?.children || '')).join('')
      : ''
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim()
}

function getTextContent(children) {
  if (typeof children === 'string') return children
  if (!children) return ''
  if (Array.isArray(children)) {
    return children.map(c => getTextContent(c)).join('')
  }
  if (children.props?.children) {
    return getTextContent(children.props.children)
  }
  return ''
}
