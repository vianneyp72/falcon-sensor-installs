import { useMemo, useCallback } from 'react'
import {
  ReactFlow,
  Background,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

/**
 * Parses ASCII art architecture diagrams into React Flow nodes and edges.
 * Supports:
 * - Nested boxes (┌─┐ / │ │ / └─┘)
 * - Arrows between boxes (──►, ▼, │)
 * - Labels on connections (e.g., "SSH", "HTTPS/443")
 */

function parseAsciiDiagram(text) {
  const lines = text.split('\n')
  const nodes = []
  const edges = []

  // Find all boxes by detecting ┌ and └ pairs
  const boxes = findBoxes(lines)

  // Build hierarchy (nested boxes)
  const hierarchy = buildHierarchy(boxes)

  // Convert to React Flow nodes
  let nodeId = 0
  const boxNodeMap = new Map() // maps box index to node id

  for (const box of hierarchy) {
    const id = `node-${nodeId++}`
    boxNodeMap.set(box.index, id)

    const label = extractBoxContent(lines, box)
    const isContainer = box.children && box.children.length > 0

    nodes.push({
      id,
      position: { x: box.col * 9, y: box.row * 22 },
      data: { label, isContainer, isSubSection: box.isSubSection },
      type: 'custom',
      style: {
        width: (box.width) * 9,
        height: (box.height) * 22,
      },
    })

    if (box.children) {
      for (const child of box.children) {
        const childId = `node-${nodeId++}`
        boxNodeMap.set(child.index, childId)

        const childLabel = extractBoxContent(lines, child)
        nodes.push({
          id: childId,
          position: { x: (child.col - box.col) * 9, y: (child.row - box.row) * 22 },
          data: { label: childLabel, isContainer: false, isSubSection: child.isSubSection },
          type: 'custom',
          parentId: id,
          extent: 'parent',
          style: {
            width: (child.width) * 9,
            height: (child.height) * 22,
          },
        })
      }
    }
  }

  // Find connections (arrows between boxes)
  const connections = findConnections(lines, boxes, boxNodeMap)
  edges.push(...connections)

  return { nodes, edges }
}

function findBoxes(lines) {
  const boxes = []
  const visited = new Set()

  for (let row = 0; row < lines.length; row++) {
    const line = lines[row]
    for (let col = 0; col < line.length; col++) {
      const key = `${row},${col}`
      if (line[col] === '┌' && !visited.has(key)) {
        const box = traceBox(lines, row, col)
        if (box) {
          box.index = boxes.length
          boxes.push(box)
          visited.add(key)
        }
      }
    }
  }

  return boxes
}

function traceBox(lines, startRow, startCol) {
  // Find the right edge of the top border
  const topLine = lines[startRow]
  let endCol = startCol + 1
  while (endCol < topLine.length && topLine[endCol] !== '┐') {
    if (topLine[endCol] !== '─' && topLine[endCol] !== '┬') return null
    endCol++
  }
  if (endCol >= topLine.length) return null

  // Find the bottom edge
  let endRow = startRow + 1
  while (endRow < lines.length) {
    const ch = lines[endRow]?.[startCol]
    if (ch === '└') break
    if (ch !== '│' && ch !== '├') return null
    endRow++
  }
  if (endRow >= lines.length) return null

  // Verify bottom-right corner
  const bottomLine = lines[endRow]
  if (!bottomLine) return null
  // The bottom right could be ┘ or ┘ could be at a different position due to sub-sections
  let bottomEndCol = startCol + 1
  while (bottomEndCol < bottomLine.length && bottomLine[bottomEndCol] !== '┘') {
    if (bottomLine[bottomEndCol] !== '─' && bottomLine[bottomEndCol] !== '┴' && bottomLine[bottomEndCol] !== '┬' && bottomLine[bottomEndCol] !== '┼') {
      break
    }
    bottomEndCol++
  }

  // Check if there's a ├───┤ divider (sub-section marker)
  let isSubSection = false
  for (let r = startRow + 1; r < endRow; r++) {
    if (lines[r]?.[startCol] === '├') {
      isSubSection = true
      break
    }
  }

  return {
    row: startRow,
    col: startCol,
    width: endCol - startCol + 1,
    height: endRow - startRow + 1,
    endRow,
    endCol,
    isSubSection,
  }
}

function buildHierarchy(boxes) {
  const roots = []
  const children = new Set()

  for (let i = 0; i < boxes.length; i++) {
    let isChild = false
    for (let j = 0; j < boxes.length; j++) {
      if (i === j) continue
      if (isInside(boxes[i], boxes[j])) {
        if (!boxes[j].children) boxes[j].children = []
        boxes[j].children.push(boxes[i])
        children.add(i)
        isChild = true
        break
      }
    }
    if (!isChild) {
      roots.push(boxes[i])
    }
  }

  return roots
}

function isInside(inner, outer) {
  return (
    inner.row > outer.row &&
    inner.col > outer.col &&
    inner.row + inner.height - 1 < outer.row + outer.height - 1 &&
    inner.col + inner.width - 1 < outer.col + outer.width - 1
  )
}

function extractBoxContent(lines, box) {
  const content = []
  for (let r = box.row + 1; r < box.row + box.height - 1; r++) {
    const line = lines[r]
    if (!line) continue
    // Extract text between the vertical borders
    let text = ''
    if (line[box.col] === '│' || line[box.col] === '├') {
      text = line.substring(box.col + 1, box.col + box.width - 1).trim()
      // Skip divider lines
      if (/^[─┬┴┼]+$/.test(text)) continue
      if (text) content.push(text)
    }
  }
  return content.join('\n')
}

function findConnections(lines, boxes, boxNodeMap) {
  const edges = []
  let edgeId = 0

  // Look for arrows (▼, ▲, ──►, ◄──) between boxes
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row]
    for (let col = 0; col < line.length; col++) {
      if (line[col] === '▼' || line[col] === '▲') {
        // Vertical arrow - find source and target boxes
        const source = findBoxAbove(boxes, row, col)
        const target = findBoxBelow(boxes, row, col)
        if (source !== null && target !== null) {
          const sourceId = boxNodeMap.get(source)
          const targetId = boxNodeMap.get(target)
          if (sourceId && targetId) {
            // Check for label on the line
            const label = findEdgeLabel(lines, row, col)
            edges.push({
              id: `edge-${edgeId++}`,
              source: sourceId,
              target: targetId,
              label: label || undefined,
              type: 'smoothstep',
              animated: true,
              style: { stroke: 'var(--accent)', strokeWidth: 1.5 },
              labelStyle: { fill: 'var(--text-muted)', fontSize: 11 },
            })
          }
        }
      }
      if (line[col] === '►' || line[col] === '▶') {
        const source = findBoxLeft(boxes, row, col)
        const target = findBoxRight(boxes, row, col)
        if (source !== null && target !== null) {
          const sourceId = boxNodeMap.get(source)
          const targetId = boxNodeMap.get(target)
          if (sourceId && targetId) {
            edges.push({
              id: `edge-${edgeId++}`,
              source: sourceId,
              target: targetId,
              type: 'smoothstep',
              animated: true,
              style: { stroke: 'var(--accent)', strokeWidth: 1.5 },
            })
          }
        }
      }
    }
  }

  return edges
}

function findBoxAbove(boxes, row, col) {
  let closest = null
  let closestDist = Infinity
  for (const box of boxes) {
    const boxBottom = box.row + box.height - 1
    if (boxBottom < row && col >= box.col && col <= box.col + box.width - 1) {
      const dist = row - boxBottom
      if (dist < closestDist) {
        closestDist = dist
        closest = box.index
      }
    }
  }
  return closest
}

function findBoxBelow(boxes, row, col) {
  let closest = null
  let closestDist = Infinity
  for (const box of boxes) {
    if (box.row > row && col >= box.col && col <= box.col + box.width - 1) {
      const dist = box.row - row
      if (dist < closestDist) {
        closestDist = dist
        closest = box.index
      }
    }
  }
  return closest
}

function findBoxLeft(boxes, row, col) {
  let closest = null
  let closestDist = Infinity
  for (const box of boxes) {
    const boxRight = box.col + box.width - 1
    if (boxRight < col && row >= box.row && row <= box.row + box.height - 1) {
      const dist = col - boxRight
      if (dist < closestDist) {
        closestDist = dist
        closest = box.index
      }
    }
  }
  return closest
}

function findBoxRight(boxes, row, col) {
  let closest = null
  let closestDist = Infinity
  for (const box of boxes) {
    if (box.col > col && row >= box.row && row <= box.row + box.height - 1) {
      const dist = box.col - col
      if (dist < closestDist) {
        closestDist = dist
        closest = box.index
      }
    }
  }
  return closest
}

function findEdgeLabel(lines, row, col) {
  // Check same line for text near the arrow
  const line = lines[row]
  const before = line.substring(Math.max(0, col - 20), col).trim()
  const after = line.substring(col + 1, col + 20).trim()

  // Filter out box-drawing chars
  const cleanBefore = before.replace(/[│├└┌┐┘─┬┴┼┤▼▲►◄▶]/g, '').trim()
  const cleanAfter = after.replace(/[│├└┌┐┘─┬┴┼┤▼▲►◄▶]/g, '').trim()

  if (cleanBefore) return cleanBefore
  if (cleanAfter) return cleanAfter

  // Check the line above for labels
  if (row > 0) {
    const above = lines[row - 1]
    const nearText = above.substring(Math.max(0, col - 10), col + 10).trim()
    const clean = nearText.replace(/[│├└┌┐┘─┬┴┼┤▼▲►◄▶]/g, '').trim()
    if (clean && !clean.includes('┐') && clean.length < 20) return clean
  }

  return null
}

// Custom node component
function CustomNode({ data }) {
  const { label, isContainer, isSubSection, isCloud, isPhase, isApi, sublabel, items } = data
  const lines = label.split('\n').filter(l => l.trim())

  const containerClass = [
    'flow-node',
    isContainer ? 'flow-node--container' : '',
    isCloud ? 'flow-node--cloud' : '',
    isPhase ? 'flow-node--phase' : '',
    isApi ? 'flow-node--api' : '',
    isSubSection ? 'flow-node--sectioned' : '',
  ].filter(Boolean).join(' ')

  const hs = { background: 'transparent', border: 'none', width: 1, height: 1 }

  const handles = (
    <>
      <Handle type="target" position={Position.Top} style={hs} />
      <Handle type="target" position={Position.Left} id="left-target" style={hs} />
      <Handle type="source" position={Position.Bottom} style={hs} />
      <Handle type="source" position={Position.Right} id="right-source" style={hs} />
    </>
  )

  if (items && items.length > 0) {
    return (
      <div className={containerClass}>
        {handles}
        <div className="flow-node__title">{lines[0]}</div>
        {items.map((item, i) => (
          <div key={i} className="flow-node__detail">• {item}</div>
        ))}
      </div>
    )
  }

  if (isSubSection) {
    const sections = []
    let current = []
    for (const line of lines) {
      if (/^[─]+$/.test(line)) {
        sections.push(current)
        current = []
      } else {
        current.push(line)
      }
    }
    if (current.length) sections.push(current)

    return (
      <div className={containerClass}>
        {handles}
        {sections.map((section, i) => (
          <div key={i} className="flow-node__section">
            {section.map((l, j) => (
              <div key={j} className={j === 0 ? 'flow-node__section-title' : 'flow-node__section-item'}>
                {l}
              </div>
            ))}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className={containerClass}>
      {handles}
      <div className="flow-node__title">{lines[0]}</div>
      {sublabel && <div className="flow-node__subtitle">{sublabel}</div>}
      {lines.slice(1).map((l, i) => (
        <div key={i} className="flow-node__detail">{l}</div>
      ))}
    </div>
  )
}

const nodeTypes = { custom: CustomNode }

/**
 * A simpler approach: Instead of parsing the complex ASCII, define diagrams
 * declaratively based on content detection.
 */
function buildSensorArchDiagram(text) {
  const nodes = [
    {
      id: 'linux-host',
      position: { x: 100, y: 0 },
      data: { label: 'Linux Host', isContainer: true },
      type: 'custom',
      style: { width: 280, height: 220 },
    },
    {
      id: 'falcon-sensor',
      position: { x: 40, y: 45 },
      data: { label: 'falcon-sensor', sublabel: 'userspace daemon' },
      type: 'custom',
      parentId: 'linux-host',
      extent: 'parent',
      style: { width: 200, height: 55 },
    },
    {
      id: 'kernel',
      position: { x: 40, y: 140 },
      data: { label: 'Linux Kernel', sublabel: 'syscalls, fs, net' },
      type: 'custom',
      parentId: 'linux-host',
      extent: 'parent',
      style: { width: 200, height: 55 },
    },
    {
      id: 'falcon-cloud',
      position: { x: 140, y: 280 },
      data: { label: 'CrowdStrike Falcon Cloud', sublabel: 'Detections & policy', isCloud: true },
      type: 'custom',
      style: { width: 200, height: 55 },
    },
  ]

  const edges = [
    { id: 'e-sensor-kernel', source: 'falcon-sensor', target: 'kernel', label: 'eBPF probes', type: 'smoothstep', animated: true, style: { stroke: '#a371f7', strokeWidth: 1.5 }, labelStyle: { fill: 'rgba(180,180,195,0.8)', fontSize: 10 }, markerEnd: { type: 'arrowclosed', color: '#a371f7' } },
    { id: 'e-host-cloud', source: 'linux-host', target: 'falcon-cloud', label: 'TLS 443', type: 'smoothstep', animated: true, style: { stroke: '#3fb950', strokeWidth: 1.5 }, labelStyle: { fill: 'rgba(180,180,195,0.8)', fontSize: 10 }, markerEnd: { type: 'arrowclosed', color: '#3fb950' } },
  ]

  return { nodes, edges }
}

function buildCloudRunPipelineDiagram(text) {
  const nodes = [
    // GitHub Actions Runner container
    {
      id: 'gh-runner',
      position: { x: 40, y: 0 },
      data: { label: 'GitHub Actions Runner', isContainer: true },
      type: 'custom',
      style: { width: 520, height: 290 },
    },
    {
      id: 'sensor-image',
      position: { x: 170, y: 40 },
      data: { label: 'Falcon Container Image', sublabel: 'contains falconutil' },
      type: 'custom',
      parentId: 'gh-runner',
      extent: 'parent',
      style: { width: 180, height: 55 },
    },
    {
      id: 'original-image',
      position: { x: 170, y: 130 },
      data: { label: 'Original App Image', sublabel: 'app:1.0 from GAR' },
      type: 'custom',
      parentId: 'gh-runner',
      extent: 'parent',
      style: { width: 180, height: 55 },
    },
    {
      id: 'wif-auth',
      position: { x: 20, y: 210 },
      data: { label: 'Auth to GCP', sublabel: 'WIF + GAR login' },
      type: 'custom',
      parentId: 'gh-runner',
      extent: 'parent',
      style: { width: 130, height: 55 },
    },
    {
      id: 'push-patched',
      position: { x: 365, y: 130 },
      data: { label: 'Push patched', sublabel: 'image to GAR' },
      type: 'custom',
      parentId: 'gh-runner',
      extent: 'parent',
      style: { width: 130, height: 55 },
    },
    // GAR
    {
      id: 'gar',
      position: { x: 60, y: 340 },
      data: {
        label: 'Google Artifact Registry',
        sublabel: 'app:1.0 / app:1.0-falcon',
        isContainer: true,
      },
      type: 'custom',
      style: { width: 480, height: 70 },
    },
    // Cloud Run
    {
      id: 'cloud-run',
      position: { x: 180, y: 460 },
      data: { label: 'Google Cloud Run', sublabel: 'falcon-sensor + your app', isCloud: true },
      type: 'custom',
      style: { width: 240, height: 55 },
    },
  ]

  const edges = [
    { id: 'e-sensor-patch', source: 'sensor-image', target: 'original-image', label: 'falconutil patch-image', type: 'smoothstep', animated: true, style: { stroke: '#a371f7', strokeWidth: 1.5 }, labelStyle: { fill: 'rgba(180,180,195,0.8)', fontSize: 10 }, markerEnd: { type: 'arrowclosed', color: '#a371f7' } },
    { id: 'e-patch-push', source: 'original-image', target: 'push-patched', label: 'patched', type: 'smoothstep', animated: true, style: { stroke: '#61C4C9', strokeWidth: 1.5 }, labelStyle: { fill: 'rgba(180,180,195,0.8)', fontSize: 10 }, markerEnd: { type: 'arrowclosed', color: '#61C4C9' } },
    { id: 'e-push-gar', source: 'push-patched', target: 'gar', label: 'docker push', type: 'smoothstep', animated: true, style: { stroke: '#d29922', strokeWidth: 1.5 }, labelStyle: { fill: 'rgba(180,180,195,0.8)', fontSize: 10 }, markerEnd: { type: 'arrowclosed', color: '#d29922' } },
    { id: 'e-wif-gar', source: 'gar', target: 'gh-runner', label: 'WIF (OIDC)', type: 'smoothstep', style: { stroke: '#61C4C9', strokeWidth: 1, strokeDasharray: '4 3' }, labelStyle: { fill: 'rgba(180,180,195,0.8)', fontSize: 10 }, markerEnd: { type: 'arrowclosed', color: '#61C4C9' } },
    { id: 'e-gar-run', source: 'gar', target: 'cloud-run', label: 'Deploy :*-falcon', type: 'smoothstep', animated: true, style: { stroke: '#3fb950', strokeWidth: 1.5 }, labelStyle: { fill: 'rgba(180,180,195,0.8)', fontSize: 10 }, markerEnd: { type: 'arrowclosed', color: '#3fb950' } },
  ]

  return { nodes, edges }
}

function buildGitHubActionsPatchDiagram(text) {
  const nodes = [
    // GitHub Actions Runner container
    {
      id: 'gh-runner',
      position: { x: 40, y: 0 },
      data: { label: 'GitHub Actions Runner', isContainer: true },
      type: 'custom',
      style: { width: 480, height: 180 },
    },
    {
      id: 'ecr-login',
      position: { x: 20, y: 50 },
      data: { label: 'ECR Login', sublabel: 'OIDC role' },
      type: 'custom',
      parentId: 'gh-runner',
      extent: 'parent',
      style: { width: 120, height: 55 },
    },
    {
      id: 'falconutil-action',
      position: { x: 175, y: 50 },
      data: { label: 'falconutil-action', sublabel: 'source → target' },
      type: 'custom',
      parentId: 'gh-runner',
      extent: 'parent',
      style: { width: 140, height: 55 },
    },
    {
      id: 'push-ecr',
      position: { x: 350, y: 50 },
      data: { label: 'Push patched', sublabel: 'image to ECR' },
      type: 'custom',
      parentId: 'gh-runner',
      extent: 'parent',
      style: { width: 120, height: 55 },
    },
    // ECR repos
    {
      id: 'ecr-apps',
      position: { x: 0, y: 230 },
      data: {
        label: 'ECR Repositories',
        sublabel: ':1.0 (unpatched) / :1.0-falcon (patched)',
        isContainer: true,
      },
      type: 'custom',
      style: { width: 360, height: 70 },
    },
    // Falcon sensor image
    {
      id: 'falcon-sensor-ecr',
      position: { x: 390, y: 230 },
      data: { label: 'Falcon Container', sublabel: 'falcon-container:latest' },
      type: 'custom',
      style: { width: 160, height: 70 },
    },
  ]

  const edges = [
    { id: 'e-login-action', source: 'ecr-login', target: 'falconutil-action', type: 'smoothstep', animated: true, style: { stroke: '#61C4C9', strokeWidth: 1.5 }, markerEnd: { type: 'arrowclosed', color: '#61C4C9' } },
    { id: 'e-action-push', source: 'falconutil-action', target: 'push-ecr', type: 'smoothstep', animated: true, style: { stroke: '#61C4C9', strokeWidth: 1.5 }, markerEnd: { type: 'arrowclosed', color: '#61C4C9' } },
    { id: 'e-push-ecr', source: 'push-ecr', target: 'ecr-apps', label: 'docker push', type: 'smoothstep', animated: true, style: { stroke: '#d29922', strokeWidth: 1.5 }, labelStyle: { fill: 'rgba(180,180,195,0.8)', fontSize: 10 }, markerEnd: { type: 'arrowclosed', color: '#d29922' } },
    { id: 'e-sensor-action', source: 'falcon-sensor-ecr', target: 'falconutil-action', label: 'sensor layer', type: 'smoothstep', animated: true, style: { stroke: '#a371f7', strokeWidth: 1.5 }, labelStyle: { fill: 'rgba(180,180,195,0.8)', fontSize: 10 }, markerEnd: { type: 'arrowclosed', color: '#a371f7' } },
  ]

  return { nodes, edges }
}

function buildFcsImageScanDiagram(text) {
  const nodes = [
    // GitHub Actions Runner
    {
      id: 'gh-runner',
      position: { x: 20, y: 0 },
      data: { label: 'GitHub Actions Runner', isContainer: true },
      type: 'custom',
      style: { width: 360, height: 160 },
    },
    {
      id: 'docker-build',
      position: { x: 20, y: 50 },
      data: { label: 'docker build', sublabel: 'Local Image' },
      type: 'custom',
      parentId: 'gh-runner',
      extent: 'parent',
      style: { width: 130, height: 55 },
    },
    {
      id: 'fcs-scan',
      position: { x: 190, y: 50 },
      data: { label: 'fcs-action', sublabel: 'scan image' },
      type: 'custom',
      parentId: 'gh-runner',
      extent: 'parent',
      style: { width: 130, height: 55 },
    },
    // CrowdStrike Cloud
    {
      id: 'cs-cloud',
      position: { x: 440, y: 30 },
      data: { label: 'CrowdStrike Cloud', sublabel: 'Image Assessment', isCloud: true },
      type: 'custom',
      style: { width: 180, height: 55 },
    },
    // Gate decision
    {
      id: 'gate',
      position: { x: 170, y: 210 },
      data: { label: 'Gate', sublabel: 'exit code 0 = pass' },
      type: 'custom',
      style: { width: 140, height: 55 },
    },
    // ghcr.io
    {
      id: 'ghcr',
      position: { x: 440, y: 210 },
      data: { label: 'ghcr.io', sublabel: 'Container Registry', isCloud: true },
      type: 'custom',
      style: { width: 160, height: 55 },
    },
  ]

  const edges = [
    { id: 'e-build-scan', source: 'docker-build', target: 'fcs-scan', type: 'smoothstep', animated: true, style: { stroke: '#61C4C9', strokeWidth: 1.5 }, markerEnd: { type: 'arrowclosed', color: '#61C4C9' } },
    { id: 'e-scan-cloud', source: 'fcs-scan', target: 'cs-cloud', label: 'Inventory only', type: 'smoothstep', animated: true, style: { stroke: '#a371f7', strokeWidth: 1.5 }, labelStyle: { fill: 'rgba(180,180,195,0.8)', fontSize: 10 }, markerEnd: { type: 'arrowclosed', color: '#a371f7' } },
    { id: 'e-cloud-gate', source: 'cs-cloud', target: 'gate', label: 'Pass / Fail', type: 'smoothstep', animated: true, style: { stroke: '#a371f7', strokeWidth: 1.5 }, labelStyle: { fill: 'rgba(180,180,195,0.8)', fontSize: 10 }, markerEnd: { type: 'arrowclosed', color: '#a371f7' } },
    { id: 'e-gate-push', source: 'gate', target: 'ghcr', label: 'docker push', type: 'smoothstep', animated: true, style: { stroke: '#3fb950', strokeWidth: 1.5 }, labelStyle: { fill: 'rgba(180,180,195,0.8)', fontSize: 10 }, markerEnd: { type: 'arrowclosed', color: '#3fb950' } },
  ]

  return { nodes, edges }
}

function buildDiagramFromContent(text) {
  // Detect which diagram this is based on content — order matters (specific before generic)
  if (text.includes('AWS Organization') && text.includes('HOST ACCOUNT') && text.includes('IOM Assessment')) {
    return buildCspmAwsOrgDiagram(text)
  }
  if (text.includes('Ansible Control Node') || text.includes('ansible-playbook')) {
    return buildAnsibleDiagram(text)
  }
  if (text.includes('WORKLOAD IDENTITY FEDERATION') || text.includes('WIF Pool')) {
    return buildWifDiagram(text)
  }
  if (text.includes('Google Artifact Registry') && text.includes('Cloud Run')) {
    return buildCloudRunPipelineDiagram(text)
  }
  if (text.includes('fcs-action') && text.includes('Image Assessment')) {
    return buildFcsImageScanDiagram(text)
  }
  if (text.includes('falconutil-action') && text.includes('ECR')) {
    return buildGitHubActionsPatchDiagram(text)
  }
  if (text.includes('BUILD TIME') || text.includes('falconutil')) {
    return buildDockerPatchDiagram(text)
  }
  if (text.includes('falcon-sensor (userspace)') && text.includes('eBPF')) {
    return buildSensorArchDiagram(text)
  }
  // Fallback: try parsing
  return parseAsciiDiagram(text)
}

function buildCspmAwsOrgDiagram(text) {
  const nodes = [
    {
      id: 'org',
      position: { x: 0, y: 0 },
      data: { label: 'AWS Organization (r-n7ay)', sublabel: 'OU: cs-demo', isContainer: true },
      type: 'custom',
      style: { width: 520, height: 320 },
    },
    {
      id: 'host',
      position: { x: 20, y: 50 },
      data: { label: 'Security (494873120176)', sublabel: 'HOST ACCOUNT', items: ['IAM Reader Role', 'Agentless Integration Role', 'Scanner VPC + NAT'] },
      type: 'custom',
      parentId: 'org',
      extent: 'parent',
      style: { width: 230, height: 130 },
    },
    {
      id: 'dev',
      position: { x: 270, y: 50 },
      data: { label: 'Development', sublabel: '934822761019', items: ['IAM Reader Role'] },
      type: 'custom',
      parentId: 'org',
      extent: 'parent',
      style: { width: 220, height: 55 },
    },
    {
      id: 'prod',
      position: { x: 270, y: 120 },
      data: { label: 'Production', sublabel: '517728567948', items: ['IAM Reader Role'] },
      type: 'custom',
      parentId: 'org',
      extent: 'parent',
      style: { width: 220, height: 55 },
    },
    {
      id: 'sandbox',
      position: { x: 270, y: 190 },
      data: { label: 'Sandbox', sublabel: '019313283882', items: ['IAM Reader Role'] },
      type: 'custom',
      parentId: 'org',
      extent: 'parent',
      style: { width: 220, height: 55 },
    },
    {
      id: 'falcon',
      position: { x: 130, y: 380 },
      data: { label: 'CrowdStrike Falcon Cloud', sublabel: 'Asset Inventory + IOM Assessment + IOA Detection', isCloud: true },
      type: 'custom',
      style: { width: 260, height: 60 },
    },
  ]

  const edges = [
    {
      id: 'e-host-falcon',
      source: 'host',
      target: 'falcon',
      label: 'TLS 443',
      type: 'smoothstep',
      animated: true,
      style: { stroke: '#3fb950', strokeWidth: 1.5 },
      labelStyle: { fill: 'rgba(180,180,195,0.8)', fontSize: 10 },
      markerEnd: { type: 'arrowclosed', color: '#3fb950' },
    },
    {
      id: 'e-dev-falcon',
      source: 'dev',
      target: 'falcon',
      type: 'smoothstep',
      animated: true,
      style: { stroke: '#61C4C9', strokeWidth: 1.2 },
      markerEnd: { type: 'arrowclosed', color: '#61C4C9' },
    },
    {
      id: 'e-prod-falcon',
      source: 'prod',
      target: 'falcon',
      type: 'smoothstep',
      animated: true,
      style: { stroke: '#61C4C9', strokeWidth: 1.2 },
      markerEnd: { type: 'arrowclosed', color: '#61C4C9' },
    },
    {
      id: 'e-sandbox-falcon',
      source: 'sandbox',
      target: 'falcon',
      type: 'smoothstep',
      animated: true,
      style: { stroke: '#61C4C9', strokeWidth: 1.2 },
      markerEnd: { type: 'arrowclosed', color: '#61C4C9' },
    },
  ]

  return { nodes, edges }
}

function buildAnsibleDiagram(text) {
  const nodes = [
    {
      id: 'workstation',
      position: { x: 180, y: 0 },
      data: {
        label: 'Your Workstation',
        sublabel: 'Ansible Control Node',
        isContainer: true,
      },
      type: 'custom',
      style: { width: 340, height: 180 },
    },
    {
      id: 'falcon-install',
      position: { x: 20, y: 55 },
      data: {
        label: 'falcon_install',
        sublabel: 'Downloads & installs sensor',
      },
      type: 'custom',
      parentId: 'workstation',
      extent: 'parent',
      style: { width: 300, height: 50 },
    },
    {
      id: 'falcon-configure',
      position: { x: 20, y: 115 },
      data: {
        label: 'falcon_configure',
        sublabel: 'Sets CID, tags & starts service',
      },
      type: 'custom',
      parentId: 'workstation',
      extent: 'parent',
      style: { width: 300, height: 50 },
    },
    {
      id: 'falcon-api',
      position: { x: 560, y: 60 },
      data: {
        label: 'Falcon API',
        sublabel: 'api.crowdstrike.com',
        isApi: true,
      },
      type: 'custom',
      style: { width: 160, height: 55 },
    },
    {
      id: 'deb12',
      position: { x: 120, y: 290 },
      data: {
        label: 'falcon-linux-deb-12',
        sublabel: 'Debian 12 Bookworm',
      },
      type: 'custom',
      style: { width: 170, height: 55 },
    },
    {
      id: 'deb13',
      position: { x: 410, y: 290 },
      data: {
        label: 'falcon-linux-deb-13',
        sublabel: 'Debian 13 Trixie',
      },
      type: 'custom',
      style: { width: 170, height: 55 },
    },
    {
      id: 'cloud',
      position: { x: 260, y: 410 },
      data: {
        label: 'CrowdStrike Cloud',
        sublabel: 'Telemetry & detections',
        isCloud: true,
      },
      type: 'custom',
      style: { width: 180, height: 55 },
    },
  ]

  const edges = [
    // Workstation authenticates to Falcon API
    { id: 'e-api', source: 'workstation', target: 'falcon-api', label: 'OAuth2', type: 'smoothstep', animated: true, style: { stroke: '#a371f7', strokeWidth: 1.5 }, labelStyle: { fill: 'rgba(180,180,195,0.8)', fontSize: 10 }, markerEnd: { type: 'arrowclosed', color: '#a371f7' } },
    // Falcon API returns sensor download + CID
    { id: 'e-api-back', source: 'falcon-api', target: 'workstation', label: 'Sensor pkg + CID', type: 'smoothstep', style: { stroke: '#a371f7', strokeWidth: 1, strokeDasharray: '4 3' }, labelStyle: { fill: 'rgba(180,180,195,0.8)', fontSize: 10 }, markerEnd: { type: 'arrowclosed', color: '#a371f7' } },
    // Workstation deploys to VMs via SSH
    { id: 'e-ssh1', source: 'workstation', target: 'deb12', label: 'SSH', type: 'smoothstep', animated: true, style: { stroke: '#61C4C9', strokeWidth: 1.5 }, labelStyle: { fill: 'rgba(180,180,195,0.8)', fontSize: 10 }, markerEnd: { type: 'arrowclosed', color: '#61C4C9' } },
    { id: 'e-ssh2', source: 'workstation', target: 'deb13', label: 'SSH', type: 'smoothstep', animated: true, style: { stroke: '#61C4C9', strokeWidth: 1.5 }, labelStyle: { fill: 'rgba(180,180,195,0.8)', fontSize: 10 }, markerEnd: { type: 'arrowclosed', color: '#61C4C9' } },
    // VMs report telemetry to CrowdStrike Cloud
    { id: 'e-telem1', source: 'deb12', target: 'cloud', label: 'HTTPS/443', type: 'smoothstep', animated: true, style: { stroke: '#3fb950', strokeWidth: 1.5 }, labelStyle: { fill: 'rgba(180,180,195,0.8)', fontSize: 10 }, markerEnd: { type: 'arrowclosed', color: '#3fb950' } },
    { id: 'e-telem2', source: 'deb13', target: 'cloud', label: 'HTTPS/443', type: 'smoothstep', animated: true, style: { stroke: '#3fb950', strokeWidth: 1.5 }, labelStyle: { fill: 'rgba(180,180,195,0.8)', fontSize: 10 }, markerEnd: { type: 'arrowclosed', color: '#3fb950' } },
  ]

  return { nodes, edges }
}

function buildWifDiagram(text) {
  const nodes = [
    {
      id: 'github-runner',
      position: { x: 0, y: 80 },
      data: {
        label: 'GitHub Actions Runner',
        sublabel: 'Sends OIDC token (JWT)',
      },
      type: 'custom',
      style: { width: 180, height: 60 },
    },
    {
      id: 'wif-pool',
      position: { x: 250, y: 0 },
      data: {
        label: 'WIF Pool + Provider',
        sublabel: 'Steps 2 & 3',
        items: ['Validates GitHub OIDC token', 'Checks repo matches condition'],
      },
      type: 'custom',
      style: { width: 220, height: 100 },
    },
    {
      id: 'iam-binding',
      position: { x: 250, y: 150 },
      data: {
        label: 'IAM Binding',
        sublabel: 'Step 4',
        items: ['principalSet → SA', 'Workload Identity User role'],
      },
      type: 'custom',
      style: { width: 220, height: 100 },
    },
    {
      id: 'service-account',
      position: { x: 540, y: 80 },
      data: {
        label: 'Service Account',
        sublabel: 'github-actions-falcon (Step 1)',
        isApi: true,
      },
      type: 'custom',
      style: { width: 190, height: 60 },
    },
    {
      id: 'gar',
      position: { x: 540, y: 220 },
      data: {
        label: 'Artifact Registry',
        sublabel: 'Push/pull images',
        isCloud: true,
      },
      type: 'custom',
      style: { width: 190, height: 60 },
    },
  ]

  const edges = [
    { id: 'e-gh-wif', source: 'github-runner', target: 'wif-pool', label: 'OIDC Token', type: 'smoothstep', animated: true, style: { stroke: '#a371f7', strokeWidth: 1.5 }, labelStyle: { fill: 'rgba(180,180,195,0.8)', fontSize: 10 }, markerEnd: { type: 'arrowclosed', color: '#a371f7' } },
    { id: 'e-wif-iam', source: 'wif-pool', target: 'iam-binding', label: 'Token valid?', type: 'smoothstep', animated: true, style: { stroke: '#61C4C9', strokeWidth: 1.5 }, labelStyle: { fill: 'rgba(180,180,195,0.8)', fontSize: 10 }, markerEnd: { type: 'arrowclosed', color: '#61C4C9' } },
    { id: 'e-iam-sa', source: 'iam-binding', target: 'service-account', label: 'Impersonate', type: 'smoothstep', animated: true, style: { stroke: '#3fb950', strokeWidth: 1.5 }, labelStyle: { fill: 'rgba(180,180,195,0.8)', fontSize: 10 }, markerEnd: { type: 'arrowclosed', color: '#3fb950' } },
    { id: 'e-sa-gar', source: 'service-account', target: 'gar', label: 'Access granted', type: 'smoothstep', animated: true, style: { stroke: '#d29922', strokeWidth: 1.5 }, labelStyle: { fill: 'rgba(180,180,195,0.8)', fontSize: 10 }, markerEnd: { type: 'arrowclosed', color: '#d29922' } },
  ]

  return { nodes, edges }
}

function buildDockerPatchDiagram(text) {
  const nodes = [
    // Build time section
    {
      id: 'build-container',
      position: { x: 0, y: 0 },
      data: { label: 'BUILD TIME', isContainer: true, isPhase: true },
      type: 'custom',
      style: { width: 580, height: 200 },
    },
    {
      id: 'source-image',
      position: { x: 20, y: 55 },
      data: { label: 'Your App Image', sublabel: '(source)' },
      type: 'custom',
      parentId: 'build-container',
      extent: 'parent',
      style: { width: 130, height: 55 },
    },
    {
      id: 'falconutil',
      position: { x: 210, y: 55 },
      data: { label: 'falconutil', sublabel: 'patch-image' },
      type: 'custom',
      parentId: 'build-container',
      extent: 'parent',
      style: { width: 130, height: 55 },
    },
    {
      id: 'patched-image',
      position: { x: 410, y: 55 },
      data: { label: 'Patched Image', sublabel: '(target)' },
      type: 'custom',
      parentId: 'build-container',
      extent: 'parent',
      style: { width: 130, height: 55 },
    },
    {
      id: 'sensor-image',
      position: { x: 210, y: 130 },
      data: { label: 'Falcon Sensor Image', sublabel: 'registry.crowdstrike.com' },
      type: 'custom',
      parentId: 'build-container',
      extent: 'parent',
      style: { width: 170, height: 55 },
    },
    // Registry
    {
      id: 'registry',
      position: { x: 610, y: 50 },
      data: { label: 'Container Registry', sublabel: 'ECR / GAR / ACR' },
      type: 'custom',
      style: { width: 160, height: 55 },
    },
    // Runtime section
    {
      id: 'run-container',
      position: { x: 0, y: 250 },
      data: { label: 'RUN TIME', isContainer: true, isPhase: true },
      type: 'custom',
      style: { width: 580, height: 170 },
    },
    {
      id: 'patched-runtime',
      position: { x: 40, y: 45 },
      data: { label: 'Patched Container', isContainer: true },
      type: 'custom',
      parentId: 'run-container',
      extent: 'parent',
      style: { width: 500, height: 110 },
    },
    {
      id: 'sensor-runtime',
      position: { x: 20, y: 38 },
      data: { label: 'Falcon Sensor', sublabel: '(user-space daemon)' },
      type: 'custom',
      parentId: 'patched-runtime',
      extent: 'parent',
      style: { width: 150, height: 55 },
    },
    {
      id: 'flask-runtime',
      position: { x: 230, y: 38 },
      data: { label: 'Your App', sublabel: 'Listening on :5000' },
      type: 'custom',
      parentId: 'patched-runtime',
      extent: 'parent',
      style: { width: 150, height: 55 },
    },
    // Falcon Cloud
    {
      id: 'falcon-cloud',
      position: { x: 200, y: 470 },
      data: { label: 'CrowdStrike Cloud', sublabel: 'Telemetry & detections', isCloud: true },
      type: 'custom',
      style: { width: 180, height: 55 },
    },
  ]

  const edges = [
    // Build flow: source → falconutil → patched
    { id: 'e-build1', source: 'source-image', target: 'falconutil', type: 'smoothstep', animated: true, style: { stroke: '#61C4C9', strokeWidth: 1.5 }, markerEnd: { type: 'arrowclosed', color: '#61C4C9' } },
    { id: 'e-build2', source: 'falconutil', target: 'patched-image', type: 'smoothstep', animated: true, style: { stroke: '#61C4C9', strokeWidth: 1.5 }, markerEnd: { type: 'arrowclosed', color: '#61C4C9' } },
    // Sensor image feeds into falconutil
    { id: 'e-sensor-in', source: 'sensor-image', target: 'falconutil', label: 'Injects sensor', type: 'smoothstep', animated: true, style: { stroke: '#a371f7', strokeWidth: 1.5 }, labelStyle: { fill: 'rgba(180,180,195,0.8)', fontSize: 10 }, markerEnd: { type: 'arrowclosed', color: '#a371f7' } },
    // Patched image pushed to registry
    { id: 'e-push', source: 'patched-image', target: 'registry', label: 'docker push', type: 'smoothstep', animated: true, style: { stroke: '#d29922', strokeWidth: 1.5 }, labelStyle: { fill: 'rgba(180,180,195,0.8)', fontSize: 10 }, markerEnd: { type: 'arrowclosed', color: '#d29922' } },
    // Registry pulled at runtime
    { id: 'e-pull', source: 'registry', target: 'run-container', label: 'docker run', type: 'smoothstep', style: { stroke: '#d29922', strokeWidth: 1, strokeDasharray: '4 3' }, labelStyle: { fill: 'rgba(180,180,195,0.8)', fontSize: 10 }, markerEnd: { type: 'arrowclosed', color: '#d29922' } },
    // Sensor reports to cloud at runtime
    { id: 'e-telemetry', source: 'sensor-runtime', target: 'falcon-cloud', label: 'HTTPS/443', type: 'smoothstep', animated: true, style: { stroke: '#3fb950', strokeWidth: 1.5 }, labelStyle: { fill: 'rgba(180,180,195,0.8)', fontSize: 10 }, markerEnd: { type: 'arrowclosed', color: '#3fb950' } },
  ]

  return { nodes, edges }
}

export function isAsciiDiagram(text) {
  const boxChars = /[┌┐└┘│├┤─┬┴┼]/
  const lines = text.split('\n')
  const boxLines = lines.filter(l => boxChars.test(l))
  // It's a diagram if >30% of lines have box chars and there are arrows
  return boxLines.length > 3 && (text.includes('▼') || text.includes('►') || text.includes('──►') || text.includes('▶'))
}

export default function FlowDiagram({ content }) {
  const { initialNodes, initialEdges } = useMemo(() => {
    const result = buildDiagramFromContent(content)
    return { initialNodes: result.nodes, initialEdges: result.edges }
  }, [content])

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)

  return (
    <div className="flow-diagram">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesDraggable={true}
        nodesConnectable={false}
        zoomOnScroll={false}
        panOnScroll={true}
        minZoom={0.5}
        maxZoom={1.5}
        defaultEdgeOptions={{ type: 'smoothstep' }}
      >
        <Background color="rgba(97, 196, 201, 0.05)" gap={24} size={1} variant="dots" />
      </ReactFlow>
    </div>
  )
}
