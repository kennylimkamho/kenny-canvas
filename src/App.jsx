import { useState, useRef, useEffect, useCallback } from 'react'
import { Stage, Layer, Image as KonvaImage, Text, Rect, Group, Transformer, Circle } from 'react-konva'
import { jsPDF } from 'jspdf'

// ─────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────
const GRID_SIZE = 50
const STICKY_COLORS = ['#fef08a', '#fca5a5', '#a5f3fc', '#d9f99d', '#f5d0fe', '#fed7aa']
const MAX_IMAGE_W = 800

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────
let _id = 1
const uid = () => _id++

function snapGrid(v, gs = GRID_SIZE) {
  return gs * Math.round(v / gs)
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new window.Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

function pointInRect(px, py, rx, ry, rw, rh) {
  return px >= rx && px <= rx + rw && py >= ry && py <= ry + rh
}

function rectsOverlap(a, b) {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y)
}

// ─────────────────────────────────────────────
//  Persist to localStorage
// ─────────────────────────────────────────────
function saveItems(items) {
  try {
    const serializable = items.map(item => {
      if (item.type === 'image' || item.type === 'video') {
        // Don't persist blob URLs — they'll be restored on reload
        return { ...item, src: null, mediaObj: null }
      }
      return { ...item }
    })
    localStorage.setItem('canvas_items', JSON.stringify(serializable))
  } catch (e) {
    console.warn('Failed to save canvas state:', e)
  }
}

// ─────────────────────────────────────────────
//  App
// ─────────────────────────────────────────────
export default function App() {
  const stageRef = useRef(null)
  const transformerRef = useRef(null)
  const [items, setItems] = useState([])
  const [selectedIds, setSelectedIds] = useState([])
  const [stagePos, setStagePos] = useState({ x: 0, y: 0 })
  const [stageScale, setStageScale] = useState(1)
  const [showGrid, setShowGrid] = useState(true)
  const [contextMenu, setContextMenu] = useState(null)
  const [stickyInput, setStickyInput] = useState(null) // { x, y }
  const [textInput, setTextInput] = useState(null)
  const [exportModal, setExportModal] = useState(false)
  const [exportType, setExportType] = useState('png')
  const [exportSize, setExportSize] = useState('1x')
  const [selectionBox, setSelectionBox] = useState(null) // { x, y, w, h } in screen coords
  const [isSelecting, setIsSelecting] = useState(false)
  const [selStart, setSelStart] = useState(null)
  const [history, setHistory] = useState([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const isPanningRef = useRef(false)
  const panStartRef = useRef({ x: 0, y: 0 })
  const stagePosStartRef = useRef({ x: 0, y: 0 })
  const dragStartRef = useRef({ x: 0, y: 0 })
  const draggingRef = useRef(false)
  const mediaCache = useRef({}) // src -> HTMLImageElement

  // ─────────────────────────────────────────────
  //  History
  // ─────────────────────────────────────────────
  const pushHistory = useCallback((newItems) => {
    setHistory(prev => {
      const trimmed = prev.slice(0, historyIndex + 1)
      return [...trimmed, JSON.stringify(newItems)]
    })
    setHistoryIndex(prev => prev + 1)
  }, [historyIndex])

  const undo = useCallback(() => {
    if (historyIndex <= 0) return
    const newIdx = historyIndex - 1
    setHistoryIndex(newIdx)
    setItems(JSON.parse(history[newIdx]))
    setSelectedIds([])
  }, [history, historyIndex])

  const redo = useCallback(() => {
    if (historyIndex >= history.length - 1) return
    const newIdx = historyIndex + 1
    setHistoryIndex(newIdx)
    setItems(JSON.parse(history[newIdx]))
    setSelectedIds([])
  }, [history, historyIndex])

  // ─────────────────────────────────────────────
  //  Stage events
  // ─────────────────────────────────────────────
  const getWorldPos = useCallback((screenX, screenY) => {
    return {
      x: (screenX - stagePos.x) / stageScale,
      y: (screenY - stagePos.y) / stageScale,
    }
  }, [stagePos, stageScale])

  const handleWheel = useCallback((e) => {
    e.evt.preventDefault()
    const stage = stageRef.current
    if (!stage) return

    if (e.evt.ctrlKey || e.evt.metaKey) {
      // Zoom
      const oldScale = stageScale
      const pointer = stage.getPointerPosition()
      const zoomFactor = e.evt.deltaY < 0 ? 1.08 : 0.93
      const newScale = Math.min(8, Math.max(0.05, oldScale * zoomFactor))

      const mouseX = pointer.x
      const mouseY = pointer.y
      const newPosX = mouseX - (mouseX - stagePos.x) * (newScale / oldScale)
      const newPosY = mouseY - (mouseY - stagePos.y) * (newScale / oldScale)

      setStageScale(newScale)
      setStagePos({ x: newPosX, y: newPosY })
    } else {
      // Pan
      setStagePos(prev => ({
        x: prev.x - e.evt.deltaX,
        y: prev.y - e.evt.deltaY,
      }))
    }
  }, [stageScale, stagePos])

  const handleStageMouseDown = useCallback((e) => {
    const stage = stageRef.current
    if (!stage) return

    // Close context menu
    setContextMenu(null)

    // Check if clicked on empty area
    const clickedOnEmpty = e.target === stage || e.target.name() === 'grid-bg'
    const pointer = stage.getPointerPosition()
    if (!pointer) return

    if (clickedOnEmpty) {
      // Box selection start
      setIsSelecting(true)
      setSelStart({ x: pointer.x, y: pointer.y })
      setSelectionBox({ x: pointer.x, y: pointer.y, w: 0, h: 0 })
      setSelectedIds([])
    }
  }, [])

  const handleStageMouseMove = useCallback((e) => {
    const stage = stageRef.current
    if (!stage) return
    const pointer = stage.getPointerPosition()
    if (!pointer) return

    if (isSelecting && selStart) {
      const x = Math.min(selStart.x, pointer.x)
      const y = Math.min(selStart.y, pointer.y)
      const w = Math.abs(pointer.x - selStart.x)
      const h = Math.abs(pointer.y - selStart.y)
      setSelectionBox({ x, y, w, h })

      // Find overlapping items
      const selWorld = {
        x: (x - stagePos.x) / stageScale,
        y: (y - stagePos.y) / stageScale,
        w: w / stageScale,
        h: h / stageScale,
      }
      const overlapping = items
        .filter(item => rectsOverlap(selWorld, { x: item.x, y: item.y, w: item.w, h: item.h }))
        .map(i => i.id)
      setSelectedIds(overlapping)
    }
  }, [isSelecting, selStart, stagePos, stageScale, items])

  const handleStageMouseUp = useCallback(() => {
    setIsSelecting(false)
    setSelStart(null)
    setSelectionBox(null)
  }, [])

  // ─────────────────────────────────────────────
  //  Item events
  // ─────────────────────────────────────────────
  const handleItemClick = useCallback((e, id) => {
    e.cancelBubble = true
    const item = items.find(i => i.id === id)
    if (!item) return

    if (e.evt.shiftKey) {
      // Toggle selection
      setSelectedIds(prev =>
        prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
      )
    } else {
      setSelectedIds([id])
    }
  }, [items])

  const handleItemDragStart = useCallback((e, id) => {
    dragStartRef.current = { x: e.target.x(), y: e.target.y() }
    draggingRef.current = true
  }, [])

  const handleItemDragEnd = useCallback((e, id) => {
    draggingRef.current = false
    const newX = e.target.x()
    const newY = e.target.y()

    setItems(prev => {
      const updated = prev.map(item => {
        if (item.id === id) {
          return { ...item, x: newX, y: newY }
        }
        // Move all selected items together
        if (selectedIds.includes(item.id) && item.id !== id) {
          const dx = newX - dragStartRef.current.x
          const dy = newY - dragStartRef.current.y
          return { ...item, x: item.x + dx, y: item.y + dy }
        }
        return item
      })
      pushHistory(updated)
      saveItems(updated)
      return updated
    })

    // Update selected positions for non-dragged selected items
    if (selectedIds.length > 1 && !selectedIds.includes(id)) {
      // handled in map above
    }
  }, [selectedIds, pushHistory])

  const handleItemTransformEnd = useCallback((e, id) => {
    const node = e.target
    const scaleX = node.scaleX()
    const scaleY = node.scaleY()
    const item = items.find(i => i.id === id)
    if (!item) return

    const newW = Math.max(20, (item.w || 100) * scaleX)
    const newH = Math.max(20, (item.h || 100) * scaleY)

    const updated = items.map(it => {
      if (it.id === id) {
        return { ...it, x: node.x(), y: node.y(), w: newW, h: newH }
      }
      return it
    })

    node.scaleX(1)
    node.scaleY(1)
    node.width(newW)
    node.height(newH)

    setItems(updated)
    pushHistory(updated)
    saveItems(updated)
  }, [items, pushHistory])

  // ─────────────────────────────────────────────
  //  Context menu
  // ─────────────────────────────────────────────
  const handleContextMenu = useCallback((e, id) => {
    e.evt.preventDefault()
    e.cancelBubble = true
    if (!selectedIds.includes(id)) {
      setSelectedIds([id])
    }
    setContextMenu({
      x: e.evt.clientX,
      y: e.evt.clientY,
      itemId: id,
    })
  }, [selectedIds])

  const closeContextMenu = useCallback(() => setContextMenu(null), [])

  const deleteSelected = useCallback(() => {
    if (selectedIds.length === 0) return
    const updated = items.filter(i => !selectedIds.includes(i.id))
    setItems(updated)
    pushHistory(updated)
    saveItems(updated)
    setSelectedIds([])
    setContextMenu(null)
  }, [selectedIds, items, pushHistory])

  const duplicateSelected = useCallback(() => {
    const newItems = items.map(item => {
      if (!selectedIds.includes(item.id)) return null
      const newId = uid()
      return {
        ...item,
        id: newId,
        x: item.x + 40,
        y: item.y + 40,
        src: item.src, // blob URL still valid
      }
    }).filter(Boolean)

    const updated = [...items, ...newItems]
    setItems(updated)
    pushHistory(updated)
    saveItems(updated)
    setSelectedIds(newItems.map(i => i.id))
    setContextMenu(null)
  }, [selectedIds, items, pushHistory])

  const bringForward = useCallback(() => {
    setItems(prev => {
      const idx = prev.findIndex(i => selectedIds.includes(i.id))
      if (idx === -1 || idx === prev.length - 1) return prev
      const updated = [...prev]
      const [item] = updated.splice(idx, 1)
      updated.push(item)
      pushHistory(updated)
      saveItems(updated)
      return updated
    })
    setContextMenu(null)
  }, [selectedIds, pushHistory])

  const sendBackward = useCallback(() => {
    setItems(prev => {
      const idx = prev.findIndex(i => selectedIds.includes(i.id))
      if (idx <= 0) return prev
      const updated = [...prev]
      const [item] = updated.splice(idx, 1)
      updated.unshift(item)
      pushHistory(updated)
      saveItems(updated)
      return updated
    })
    setContextMenu(null)
  }, [selectedIds, pushHistory])

  // ─────────────────────────────────────────────
  //  Add items
  // ─────────────────────────────────────────────
  const addStickyNote = useCallback((x, y, text, color) => {
    const id = uid()
    const item = {
      id,
      type: 'sticky',
      x,
      y,
      w: 200,
      h: 200,
      text: text || '',
      color: color || STICKY_COLORS[0],
      fontSize: 14,
    }
    const updated = [...items, item]
    setItems(updated)
    pushHistory(updated)
    saveItems(updated)
    setSelectedIds([id])
  }, [items, pushHistory])

  const addTextBox = useCallback((x, y, text) => {
    const id = uid()
    const item = {
      id,
      type: 'text',
      x,
      y,
      w: 300,
      h: 60,
      text: text || '',
      fontSize: 20,
      color: '#e0e0e0',
    }
    const updated = [...items, item]
    setItems(updated)
    pushHistory(updated)
    saveItems(updated)
    setSelectedIds([id])
  }, [items, pushHistory])

  // ─────────────────────────────────────────────
  //  File drop
  // ─────────────────────────────────────────────
  const handleDrop = useCallback(async (e) => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files)
    if (!files.length) return

    const stage = stageRef.current
    if (!stage) return
    const stageBox = stage.container().getBoundingClientRect()
    const dropX = e.clientX - stageBox.left
    const dropY = e.clientY - stageBox.top
    const worldPos = getWorldPos(dropX, dropY)

    let x = worldPos.x
    const gap = 30

    for (const file of files) {
      const isImage = file.type.startsWith('image/')
      const isVideo = file.type.startsWith('video/')
      if (!isImage && !isVideo) continue

      const url = URL.createObjectURL(file)
      const id = uid()

      if (isImage) {
        try {
          const img = await loadImage(url)
          let w = img.naturalWidth
          let h = img.naturalHeight
          if (w > MAX_IMAGE_W) { h = h * MAX_IMAGE_W / w; w = MAX_IMAGE_W }
          mediaCache.current[url] = img
          const item = { id, type: 'image', x: x - w / 2, y: worldPos.y - h / 2, w, h, src: url }
          setItems(prev => {
            const updated = [...prev, item]
            pushHistory(updated)
            saveItems(updated)
            return updated
          })
          x += w + gap
        } catch (err) {
          console.error('Failed to load image:', err)
        }
      } else {
        // Video — load first frame
        const vid = document.createElement('video')
        vid.src = url
        vid.muted = true
        vid.playsInline = true
        vid.preload = 'metadata'
        vid.onloadedmetadata = () => {
          let w = vid.videoWidth
          let h = vid.videoHeight
          if (w > MAX_IMAGE_W) { h = h * MAX_IMAGE_W / w; w = MAX_IMAGE_W }

          // Seek to first frame
          vid.currentTime = 0.1
          vid.onseeked = () => {
            const canvas = document.createElement('canvas')
            canvas.width = w
            canvas.height = h
            const ctx = canvas.getContext('2d')
            ctx.drawImage(vid, 0, 0, w, h)
            const thumbUrl = canvas.toDataURL('image/jpeg', 0.8)

            loadImage(thumbUrl).then(thumb => {
              mediaCache.current[thumbUrl] = thumb
              const item = {
                id,
                type: 'video',
                x: x - w / 2,
                y: worldPos.y - h / 2,
                w,
                h,
                src: url,
                thumbUrl,
                videoEl: vid,
                playing: false,
              }
              setItems(prev => {
                const updated = [...prev, item]
                pushHistory(updated)
                saveItems(updated)
                return updated
              })
            })
          }
        }
        x += MAX_IMAGE_W + gap
      }
    }
    setSelectedIds([])
  }, [getWorldPos, pushHistory])

  // ─────────────────────────────────────────────
  //  Video play/pause
  // ─────────────────────────────────────────────
  const toggleVideoPlay = useCallback((id) => {
    setItems(prev => {
      const updated = prev.map(item => {
        if (item.id !== id || item.type !== 'video') return item
        const vid = item.videoEl
        if (!vid) return item
        if (vid.paused) {
          vid.play().catch(() => {})
        } else {
          vid.pause()
        }
        return { ...item, playing: !item.playing }
      })
      saveItems(updated)
      return updated
    })
  }, [])

  // ─────────────────────────────────────────────
  //  Text editing (double-click)
  // ─────────────────────────────────────────────
  const handleDblClick = useCallback((e, id) => {
    const item = items.find(i => i.id === id)
    if (!item) return
    if (item.type === 'video') {
      toggleVideoPlay(id)
      return
    }
    if (item.type === 'text' || item.type === 'sticky') {
      const text = prompt('Edit text:', item.text)
      if (text === null) return
      const updated = items.map(it => it.id === id ? { ...it, text } : it)
      setItems(updated)
      pushHistory(updated)
      saveItems(updated)
    }
  }, [items, toggleVideoPlay, pushHistory])

  // ─────────────────────────────────────────────
  //  Keyboard shortcuts
  // ─────────────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return

      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.length > 0) {
        deleteSelected()
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        undo()
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault()
        redo()
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
        e.preventDefault()
        duplicateSelected()
      }
      if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        setSelectedIds(items.map(i => i.id))
      }
      if (e.key === 'Escape') {
        setSelectedIds([])
        setContextMenu(null)
        setStickyInput(null)
        setTextInput(null)
        setExportModal(false)
      }
      if (e.key === 'g' || e.key === 'G') {
        setShowGrid(prev => !prev)
      }
      if (e.key === 'f' || e.key === 'F') {
        fitAll()
      }
      // Arrow keys nudge
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        if (selectedIds.length > 0) {
          e.preventDefault()
          const delta = e.shiftKey ? 10 : 1
          const dx = e.key === 'ArrowLeft' ? -delta : e.key === 'ArrowRight' ? delta : 0
          const dy = e.key === 'ArrowUp' ? -delta : e.key === 'ArrowDown' ? delta : 0
          setItems(prev => {
            const updated = prev.map(item =>
              selectedIds.includes(item.id) ? { ...item, x: item.x + dx, y: item.y + dy } : item
            )
            pushHistory(updated)
            saveItems(updated)
            return updated
          })
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedIds, deleteSelected, undo, redo, duplicateSelected, items, pushHistory])

  // ─────────────────────────────────────────────
  //  Fit all
  // ─────────────────────────────────────────────
  const fitAll = useCallback(() => {
    if (items.length === 0) {
      setStageScale(1)
      setStagePos({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
      return
    }
    const minX = Math.min(...items.map(i => i.x))
    const minY = Math.min(...items.map(i => i.y))
    const maxX = Math.max(...items.map(i => i.x + (i.w || 0)))
    const maxY = Math.max(...items.map(i => i.y + (i.h || 0)))
    const pad = 100
    const contentW = maxX - minX + pad * 2
    const contentH = maxY - minY + pad * 2
    const newScale = Math.min(window.innerWidth / contentW, window.innerHeight / contentH, 2)
    const newX = (window.innerWidth - (maxX + minX) * newScale) / 2
    const newY = (window.innerHeight - (maxY + minY) * newScale) / 2
    setStageScale(newScale)
    setStagePos({ x: newX, y: newY })
  }, [items])

  // ─────────────────────────────────────────────
  //  Zoom controls
  // ─────────────────────────────────────────────
  const zoomIn = () => {
    const cx = window.innerWidth / 2
    const cy = window.innerHeight / 2
    const newScale = Math.min(8, stageScale * 1.2)
    const newPosX = cx - (cx - stagePos.x) * (newScale / stageScale)
    const newPosY = cy - (cy - stagePos.y) * (newScale / stageScale)
    setStageScale(newScale)
    setStagePos({ x: newPosX, y: newPosY })
  }

  const zoomOut = () => {
    const cx = window.innerWidth / 2
    const cy = window.innerHeight / 2
    const newScale = Math.max(0.05, stageScale / 1.2)
    const newPosX = cx - (cx - stagePos.x) * (newScale / stageScale)
    const newPosY = cy - (cy - stagePos.y) * (newScale / stageScale)
    setStageScale(newScale)
    setStagePos({ x: newPosX, y: newPosY })
  }

  const handleSliderChange = (e) => {
    const newScale = parseFloat(e.target.value) / 100
    const cx = window.innerWidth / 2
    const cy = window.innerHeight / 2
    const newPosX = cx - (cx - stagePos.x) * (newScale / stageScale)
    const newPosY = cy - (cy - stagePos.y) * (newScale / stageScale)
    setStageScale(newScale)
    setStagePos({ x: newPosX, y: newPosY })
  }

  // ─────────────────────────────────────────────
  //  Export
  // ─────────────────────────────────────────────
  const handleExport = async () => {
    if (items.length === 0) return
    const stage = stageRef.current
    if (!stage) return

    // Hide transformer during export
    if (transformerRef.current) {
      transformerRef.current.hide()
    }
    stage.find('.selection').forEach(n => n.visible(false))

    const minX = Math.min(...items.map(i => i.x))
    const minY = Math.min(...items.map(i => i.y))
    const maxX = Math.max(...items.map(i => i.x + (i.w || 0)))
    const maxY = Math.max(...items.map(i => i.y + (i.h || 0)))
    const pad = 60

    const scaleMap = { '1x': 1, '2x': 2, '3x': 3, '4x': 4 }
    const exportScale = scaleMap[exportSize] || 1
    const totalW = (maxX - minX + pad * 2) * exportScale
    const totalH = (maxY - minY + pad * 2) * exportScale

    try {
      if (exportType === 'png') {
        // Use Konva's built-in export
        const uri = stage.toDataURL({
          mimeType: 'image/png',
          quality: 1,
          pixelRatio: exportScale,
          x: minX - pad,
          y: minY - pad,
          width: maxX - minX + pad * 2,
          height: maxY - minY + pad * 2,
        })

        // For very large exports, create link and download
        const link = document.createElement('a')
        link.download = `canvas-${Date.now()}.png`
        link.href = uri
        link.click()
      } else {
        // PDF
        const uri = stage.toDataURL({
          mimeType: 'image/jpeg',
          quality: 0.92,
          pixelRatio: exportScale,
          x: minX - pad,
          y: minY - pad,
          width: maxX - minX + pad * 2,
          height: maxY - minY + pad * 2,
        })

        const orientation = totalW > totalH ? 'landscape' : 'portrait'
        const pdf = new jsPDF({
          orientation,
          unit: 'px',
          format: [totalW, totalH],
        })

        pdf.addImage(uri, 'JPEG', 0, 0, totalW, totalH)
        pdf.save(`canvas-${Date.now()}.pdf`)
      }
    } catch (err) {
      console.error('Export failed:', err)
      alert('Export failed. Try a smaller size.')
    }

    // Restore transformer
    if (transformerRef.current) {
      transformerRef.current.show()
    }
    stage.find('.selection').forEach(n => n.visible(true))

    setExportModal(false)
  }

  // ─────────────────────────────────────────────
  //  Minimap drag
  // ─────────────────────────────────────────────
  const [minimapViewport, setMinimapViewport] = useState(null)

  // ─────────────────────────────────────────────
  //  Init
  // ─────────────────────────────────────────────
  useEffect(() => {
    // Set initial stage position to center of viewport
    setStagePos({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
    pushHistory([])
  }, [])

  // Update transformer when selection changes
  useEffect(() => {
    const transformer = transformerRef.current
    if (!transformer) return
    const stage = stageRef.current
    if (!stage) return

    const nodes = selectedIds.map(id => stage.findOne(`#item-${id}`)).filter(Boolean)
    transformer.nodes(nodes)
    transformer.getLayer()?.batchDraw()
  }, [selectedIds])

  // ─────────────────────────────────────────────
  //  Render grid
  // ─────────────────────────────────────────────
  const renderGrid = () => {
    if (!showGrid) return null
    const lines = []
    const gridWorld = GRID_SIZE
    // Render dots in visible area
    const stage = stageRef.current
    if (!stage) return null

    const visibleLeft = -stagePos.x / stageScale - 500
    const visibleTop = -stagePos.y / stageScale - 500
    const visibleRight = (window.innerWidth - stagePos.x) / stageScale + 500
    const visibleBottom = (window.innerHeight - stagePos.y) / stageScale + 500

    for (let x = Math.floor(visibleLeft / gridWorld) * gridWorld; x < visibleRight; x += gridWorld) {
      for (let y = Math.floor(visibleTop / gridWorld) * gridWorld; y < visibleBottom; y += gridWorld) {
        lines.push(
          <Circle
            key={`dot-${x}-${y}`}
            x={x}
            y={y}
            radius={1.2 / stageScale}
            fill="#1a1a1a"
            listening={false}
          />
        )
      }
    }
    return lines
  }

  // ─────────────────────────────────────────────
  //  Minimap
  // ─────────────────────────────────────────────
  const MM_W = 170, MM_H = 110

  const getMinimapViewport = () => {
    if (items.length === 0) return null
    const minX = Math.min(...items.map(i => i.x))
    const minY = Math.min(...items.map(i => i.y))
    const maxX = Math.max(...items.map(i => i.x + (i.w || 0)))
    const maxY = Math.max(...items.map(i => i.y + (i.h || 0)))
    const worldW = maxX - minX || 1
    const worldH = maxY - minY || 1
    const pad = 200
    const mmScaleX = (MM_W - 20) / (worldW + pad * 2)
    const mmScaleY = (MM_H - 20) / (worldH + pad * 2)
    const mmScale = Math.min(mmScaleX, mmScaleY)

    const vpX = ((-stagePos.x / stageScale) - minX + pad) * mmScale + 10
    const vpY = ((-stagePos.y / stageScale) - minY + pad) * mmScale + 10
    const vpW = (window.innerWidth / stageScale) * mmScale
    const vpH = (window.innerHeight / stageScale) * mmScale

    return { x: Math.max(0, Math.min(vpX, MM_W - 4)), y: Math.max(0, Math.min(vpY, MM_H - 4)), w: Math.min(vpW, MM_W), h: Math.min(vpH, MM_H) }
  }

  const mmViewportStyle = getMinimapViewport()

  const handleMinimapClick = (e) => {
    if (items.length === 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top

    const minX = Math.min(...items.map(i => i.x))
    const minY = Math.min(...items.map(i => i.y))
    const maxX = Math.max(...items.map(i => i.x + (i.w || 0)))
    const maxY = Math.max(...items.map(i => i.y + (i.h || 0)))
    const worldW = maxX - minX || 1
    const worldH = maxY - minY || 1
    const pad = 200
    const mmScaleX = (MM_W - 20) / (worldW + pad * 2)
    const mmScaleY = (MM_H - 20) / (worldH + pad * 2)
    const mmScale = Math.min(mmScaleX, mmScaleY)

    const wx = (mx - 10) / mmScale + minX - pad
    const wy = (my - 10) / mmScale + minY - pad

    setStagePos({
      x: -wx * stageScale + window.innerWidth / 2,
      y: -wy * stageScale + window.innerHeight / 2,
    })
  }

  // ─────────────────────────────────────────────
  //  Minimap render (DOM-based)
  // ─────────────────────────────────────────────
  const getMinimapItems = () => {
    if (items.length === 0) return []
    const minX = Math.min(...items.map(i => i.x))
    const minY = Math.min(...items.map(i => i.y))
    const maxX = Math.max(...items.map(i => i.x + (i.w || 0)))
    const maxY = Math.max(...items.map(i => i.y + (i.h || 0)))
    const worldW = maxX - minX || 1
    const worldH = maxY - minY || 1
    const pad = 200
    const mmScaleX = (MM_W - 20) / (worldW + pad * 2)
    const mmScaleY = (MM_H - 20) / (worldH + pad * 2)
    const mmScale = Math.min(mmScaleX, mmScaleY)

    return items.map(item => ({
      x: (item.x - minX + pad) * mmScale + 10,
      y: (item.y - minY + pad) * mmScale + 10,
      w: (item.w || 20) * mmScale,
      h: (item.h || 20) * mmScale,
      type: item.type,
      color: item.color,
    }))
  }

  // ─────────────────────────────────────────────
  //  Render
  // ─────────────────────────────────────────────
  return (
    <div
      style={{ width: '100vw', height: '100vh', background: '#111', position: 'relative', overflow: 'hidden' }}
      onDragOver={e => e.preventDefault()}
      onDrop={handleDrop}
    >
      {/* ── Stage ── */}
      <Stage
        ref={stageRef}
        width={window.innerWidth}
        height={window.innerHeight}
        x={stagePos.x}
        y={stagePos.y}
        scaleX={stageScale}
        scaleY={stageScale}
        onWheel={handleWheel}
        onMouseDown={handleStageMouseDown}
        onMouseMove={handleStageMouseMove}
        onMouseUp={handleStageMouseUp}
        onContextMenu={e => {
          e.evt.preventDefault()
          setContextMenu(null)
        }}
        style={{ cursor: isPanningRef.current ? 'grabbing' : 'default' }}
      >
        <Layer>
          {/* Background */}
          <Rect
            name="grid-bg"
            x={-stagePos.x / stageScale - 5000}
            y={-stagePos.y / stageScale - 5000}
            width={10000 + window.innerWidth / stageScale}
            height={10000 + window.innerHeight / stageScale}
            fill="#111"
            listening={true}
          />

          {/* Grid dots */}
          {renderGrid()}

          {/* Empty state */}
          {items.length === 0 && (
            <Group x={-stagePos.x / stageScale + window.innerWidth / 2 / stageScale - 100} y={-stagePos.y / stageScale + window.innerHeight / 2 / stageScale - 40}>
              <Text
                text="Drop images or videos here"
                fontSize={20}
                fill="#222"
                fontFamily="system-ui"
              />
            </Group>
          )}

          {/* Items */}
          {items.map(item => {
            if (item.type === 'image') {
              const img = mediaCache.current[item.src]
              if (!img) return null
              return (
                <KonvaImage
                  key={item.id}
                  id={`item-${item.id}`}
                  x={item.x}
                  y={item.y}
                  width={item.w}
                  height={item.h}
                  image={img}
                  draggable
                  onClick={e => handleItemClick(e, item.id)}
                  onTap={e => handleItemClick(e, item.id)}
                  onDragStart={e => handleItemDragStart(e, item.id)}
                  onDragEnd={e => handleItemDragEnd(e, item.id)}
                  onContextMenu={e => handleContextMenu(e, item.id)}
                  onDblClick={e => handleDblClick(e, item.id)}
                  onDblTap={e => handleDblClick(e, item.id)}
                  shadowColor="black"
                  shadowBlur={10}
                  shadowOpacity={0.4}
                  shadowOffsetY={4}
                />
              )
            }

            if (item.type === 'video') {
              const thumb = mediaCache.current[item.thumbUrl]
              return (
                <Group
                  key={item.id}
                  id={`item-${item.id}`}
                  x={item.x}
                  y={item.y}
                  width={item.w}
                  height={item.h}
                  draggable
                  onClick={e => handleItemClick(e, item.id)}
                  onTap={e => handleItemClick(e, item.id)}
                  onDragStart={e => handleItemDragStart(e, item.id)}
                  onDragEnd={e => handleItemDragEnd(e, item.id)}
                  onContextMenu={e => handleContextMenu(e, item.id)}
                  onDblClick={e => handleDblClick(e, item.id)}
                  onDblTap={e => handleDblClick(e, item.id)}
                >
                  {thumb && (
                    <KonvaImage
                      image={thumb}
                      width={item.w}
                      height={item.h}
                    />
                  )}
                  <Rect
                    width={item.w}
                    height={item.h}
                    fill="transparent"
                  />
                  {/* Play icon */}
                  <Text
                    x={item.w / 2 - 20}
                    y={item.h / 2 - 20}
                    text={item.playing ? '⏸' : '▶'}
                    fontSize={Math.min(item.w, item.h) * 0.2}
                    fill="rgba(255,255,255,0.7)"
                    listening={false}
                  />
                </Group>
              )
            }

            if (item.type === 'sticky') {
              return (
                <Group
                  key={item.id}
                  id={`item-${item.id}`}
                  x={item.x}
                  y={item.y}
                  draggable
                  onClick={e => handleItemClick(e, item.id)}
                  onTap={e => handleItemClick(e, item.id)}
                  onDragStart={e => handleItemDragStart(e, item.id)}
                  onDragEnd={e => handleItemDragEnd(e, item.id)}
                  onContextMenu={e => handleContextMenu(e, item.id)}
                  onDblClick={e => handleDblClick(e, item.id)}
                >
                  <Rect
                    width={item.w}
                    height={item.h}
                    fill={item.color}
                    cornerRadius={4}
                    shadowColor="rgba(0,0,0,0.3)"
                    shadowBlur={8}
                    shadowOffsetY={3}
                  />
                  <Text
                    x={12}
                    y={12}
                    width={item.w - 24}
                    height={item.h - 24}
                    text={item.text || 'Double-click to edit'}
                    fontSize={item.fontSize || 14}
                    fill={item.text ? '#422006' : '#a16207'}
                    fontFamily="system-ui"
                    wrap="word"
                  />
                </Group>
              )
            }

            if (item.type === 'text') {
              return (
                <Group
                  key={item.id}
                  id={`item-${item.id}`}
                  x={item.x}
                  y={item.y}
                  draggable
                  onClick={e => handleItemClick(e, item.id)}
                  onTap={e => handleItemClick(e, item.id)}
                  onDragStart={e => handleItemDragStart(e, item.id)}
                  onDragEnd={e => handleItemDragEnd(e, item.id)}
                  onContextMenu={e => handleContextMenu(e, item.id)}
                  onDblClick={e => handleDblClick(e, item.id)}
                >
                  <Text
                    text={item.text || 'Double-click to edit'}
                    fontSize={item.fontSize || 20}
                    fill={item.text ? (item.color || '#e0e0e0') : '#555'}
                    fontFamily="system-ui"
                    width={item.w}
                  />
                </Group>
              )
            }

            return null
          })}

          {/* Transformer */}
          <Transformer
            ref={transformerRef}
            boundBoxFunc={(oldBox, newBox) => {
              if (newBox.width < 20 || newBox.height < 20) return oldBox
              return newBox
            }}
            anchorSize={8}
            anchorFill="#3b82f6"
            anchorStroke="#3b82f6"
            anchorCornerRadius={2}
            borderStroke="#3b82f6"
            borderStrokeWidth={1.5}
            rotateEnabled={false}
            keepRatio={false}
            enabledAnchors={['top-left', 'top-right', 'bottom-left', 'bottom-right', 'middle-left', 'middle-right', 'top-center', 'bottom-center']}
          />
        </Layer>
      </Stage>

      {/* ── Selection box (screen coords) ── */}
      {selectionBox && selectionBox.w > 2 && (
        <div
          className="selection-box"
          style={{
            left: selectionBox.x,
            top: selectionBox.y,
            width: selectionBox.w,
            height: selectionBox.h,
          }}
        />
      )}

      {/* ── Left Toolbar ── */}
      <div className="toolbar">
        <button className="tool-btn" data-tip="Fit All (F)" onClick={fitAll}>⊡</button>
        <button className="tool-btn" data-tip="Reset" onClick={() => { setStageScale(1); setStagePos({ x: window.innerWidth / 2, y: window.innerHeight / 2 }) }}>⌂</button>
        <button className={`tool-btn ${showGrid ? 'active' : ''}`} data-tip="Grid (G)" onClick={() => setShowGrid(p => !p)}>▦</button>
        <div className="tool-divider" />
        <button className="tool-btn" data-tip="Sticky Note" onClick={() => {
          const wp = getWorldPos(window.innerWidth / 2, window.innerHeight / 2)
          setStickyInput({ x: wp.x, y: wp.y })
        }}>📝</button>
        <button className="tool-btn" data-tip="Text" onClick={() => {
          const wp = getWorldPos(window.innerWidth / 2, window.innerHeight / 2)
          setTextInput({ x: wp.x, y: wp.y })
        }}>T</button>
        <div className="tool-divider" />
        <button className="tool-btn" data-tip="Duplicate (Ctrl+D)" onClick={duplicateSelected}>⧉</button>
        <button className="tool-btn" data-tip="Delete (Del)" onClick={deleteSelected}>🗑</button>
        <div className="tool-divider" />
        <button className="tool-btn" data-tip="Undo (Ctrl+Z)" onClick={undo}>↩</button>
        <button className="tool-btn" data-tip="Redo (Ctrl+Y)" onClick={redo}>↪</button>
        <div className="tool-divider" />
        <button className="tool-btn" data-tip="Export PNG/PDF" onClick={() => setExportModal(true)}>⬇</button>
      </div>

      {/* ── Zoom Panel ── */}
      <div className="zoom-panel">
        <span className="zoom-label">ZOOM</span>
        <div className="zoom-slider-wrap">
          <input
            type="range"
            className="zoom-slider"
            min="5"
            max="500"
            value={Math.round(stageScale * 100)}
            onChange={handleSliderChange}
          />
          <span className="zoom-value">{Math.round(stageScale * 100)}%</span>
        </div>
        <div className="zoom-btns">
          <button className="zoom-btn" onClick={zoomIn}>+</button>
          <button className="zoom-btn" onClick={zoomOut}>−</button>
        </div>
      </div>

      {/* ── Info Bar ── */}
      <div className="info-bar">
        <span>{items.length}</span> items &nbsp;|&nbsp;
        <span>{Math.round(stageScale * 100)}%</span> zoom
      </div>

      {/* ── Help Panel ── */}
      <div className="help-panel">
        <kbd>Drag files</kbd> drop on canvas<br />
        <kbd>Scroll</kbd> pan &nbsp; <kbd>Ctrl+Scroll</kbd> zoom<br />
        <kbd>Click</kbd> select &nbsp; <kbd>Shift+click</kbd> multi<br />
        <kbd>Drag empty</kbd> box select<br />
        <kbd>Del</kbd> delete &nbsp; <kbd>Ctrl+D</kbd> dup<br />
        <kbd>F</kbd> fit &nbsp; <kbd>G</kbd> grid<br />
        <kbd>Ctrl+Z</kbd> undo &nbsp; <kbd>Ctrl+Y</kbd> redo<br />
        <kbd>Arrows</kbd> nudge &nbsp; <kbd>Shift+Arrows</kbd> move 10px
      </div>

      {/* ── Minimap ── */}
      <div className="minimap" onClick={handleMinimapClick}>
        <span className="minimap-label">Map</span>
        <div style={{ position: 'relative', width: MM_W, height: MM_H }}>
          {/* Item dots */}
          {getMinimapItems().map((mitem, idx) => (
            <div
              key={idx}
              style={{
                position: 'absolute',
                left: mitem.x,
                top: mitem.y,
                width: Math.max(mitem.w, 2),
                height: Math.max(mitem.h, 2),
                background: mitem.type === 'video' ? '#8b5cf6' : mitem.type === 'sticky' ? mitem.color : '#3b82f6',
                borderRadius: mitem.type === 'sticky' ? 2 : 1,
                opacity: 0.8,
              }}
            />
          ))}
          {/* Viewport indicator */}
          {mmViewportStyle && (
            <div
              className="minimap-viewport"
              style={{
                left: mmViewportStyle.x,
                top: mmViewportStyle.y,
                width: mmViewportStyle.w,
                height: mmViewportStyle.h,
              }}
            />
          )}
        </div>
      </div>

      {/* ── Context Menu ── */}
      {contextMenu && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 299 }}
            onClick={closeContextMenu}
            onContextMenu={e => { e.preventDefault(); closeContextMenu() }}
          />
          <div
            className="context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <div className="ctx-section-label">Selection</div>
            <div className="ctx-item" onClick={() => { duplicateSelected(); closeContextMenu() }}>
              <span className="icon">⧉</span> Duplicate <span className="shortcut">Ctrl+D</span>
            </div>
            <div className="ctx-item" onClick={() => { bringForward(); closeContextMenu() }}>
              <span className="icon">⬆</span> Bring Forward
            </div>
            <div className="ctx-item" onClick={() => { sendBackward(); closeContextMenu() }}>
              <span className="icon">⬇</span> Send Backward
            </div>
            <div className="ctx-divider" />
            <div className="ctx-section-label">Add</div>
            <div className="ctx-item" onClick={() => {
              closeContextMenu()
              const item = items.find(i => i.id === contextMenu.itemId)
              if (item) setStickyInput({ x: item.x + item.w + 30, y: item.y })
            }}>
              <span className="icon">📝</span> Sticky Note
            </div>
            <div className="ctx-item" onClick={() => {
              closeContextMenu()
              const item = items.find(i => i.id === contextMenu.itemId)
              if (item) setTextInput({ x: item.x + item.w + 30, y: item.y })
            }}>
              <span className="icon">T</span> Text
            </div>
            <div className="ctx-divider" />
            <div className="ctx-item danger" onClick={() => { deleteSelected(); closeContextMenu() }}>
              <span className="icon">🗑</span> Delete <span className="shortcut">Del</span>
            </div>
          </div>
        </>
      )}

      {/* ── Sticky Note Input ── */}
      {stickyInput && (
        <div className="sticky-input-overlay">
          <div className="sticky-input-backdrop" onClick={() => setStickyInput(null)} />
          <div className="sticky-input-box" style={{ background: stickyInput.color || '#fef08a' }}>
            <textarea
              autoFocus
              placeholder="Write something..."
              onKeyDown={e => {
                if (e.key === 'Escape') setStickyInput(null)
                if (e.key === 'Enter' && e.ctrlKey) {
                  addStickyNote(stickyInput.x, stickyInput.y, e.target.value, stickyInput.color)
                  setStickyInput(null)
                }
              }}
            />
            <div className="sticky-input-footer">
              <button className="sticky-btn cancel" onClick={() => setStickyInput(null)}>Cancel</button>
              <button className="sticky-btn add" onClick={() => {
                // Get text from textarea
                const ta = document.querySelector('.sticky-input-box textarea')
                addStickyNote(stickyInput.x, stickyInput.y, ta?.value || '', stickyInput.color)
                setStickyInput(null)
              }}>Add</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Text Input ── */}
      {textInput && (
        <div className="text-input-overlay">
          <div className="text-input-backdrop" onClick={() => setTextInput(null)} />
          <div className="text-input-box">
            <textarea
              autoFocus
              placeholder="Type text..."
              onKeyDown={e => {
                if (e.key === 'Escape') setTextInput(null)
                if (e.key === 'Enter' && e.ctrlKey) {
                  const ta = document.querySelector('.text-input-box textarea')
                  addTextBox(textInput.x, textInput.y, ta?.value || '')
                  setTextInput(null)
                }
              }}
            />
          </div>
        </div>
      )}

      {/* ── Export Modal ── */}
      {exportModal && (
        <div className="export-modal-backdrop">
          <div className="export-modal">
            <h3>Export Canvas</h3>
            <div className="export-options">
              <div className={`export-option ${exportType === 'png' ? 'selected' : ''}`} onClick={() => setExportType('png')}>
                <span className="opt-icon">🖼</span>
                <div className="opt-info">
                  <h4>PNG Image</h4>
                  <p>High-quality raster image, best for sharing</p>
                </div>
              </div>
              <div className={`export-option ${exportType === 'pdf' ? 'selected' : ''}`} onClick={() => setExportType('pdf')}>
                <span className="opt-icon">📄</span>
                <div className="opt-info">
                  <h4>PDF Document</h4>
                  <p>Vector-friendly document format</p>
                </div>
              </div>
            </div>
            <div className="export-size-row">
              <label>Resolution:</label>
              <select value={exportSize} onChange={e => setExportSize(e.target.value)}>
                <option value="1x">1x (Standard)</option>
                <option value="2x">2x (High)</option>
                <option value="3x">3x (Very High)</option>
                <option value="4x">4x (Print Quality)</option>
              </select>
            </div>
            <div className="export-actions">
              <button className="btn-export cancel" onClick={() => setExportModal(false)}>Cancel</button>
              <button className="btn-export primary" onClick={handleExport} disabled={items.length === 0}>
                Export {exportType.toUpperCase()}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
