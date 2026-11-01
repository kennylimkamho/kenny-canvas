import { useState } from 'react'
import App from './App.jsx'
import './Product.css'

export default function Product() {
  const [started, setStarted] = useState(false)
  if (started) return <App />
  return <main className="product-intro">
    <nav><strong>Kenny Canvas</strong><a href="https://github.com/kennylimkamho/kenny-canvas">Source & documentation ↗</a></nav>
    <section className="product-hero">
      <p className="product-label">A WORKSPACE FOR PRODUCT THINKING · PROTOTYPE</p>
      <h1>Give your ideas<br />room to connect.</h1>
      <p className="product-lede">Bring images, video and notes into one visual workspace. Compare directions, explain the tradeoffs, and turn the conversation into a clear brief.</p>
      <button onClick={() => setStarted(true)}>Open your canvas <span aria-hidden="true">↗</span></button>
      <p className="product-note">No account needed. Export your board before closing — media is not restored after reload.</p>
    </section>
    <section className="product-example" aria-label="Illustrative product planning board">
      <div className="example-caption">EXAMPLE BOARD / ONBOARDING EXPLORATION</div>
      <div className="example-layout"><article><small>01 / THE PROBLEM</small><h2>Too much setup.<br />Too little progress.</h2><p>What does someone need to achieve in their first session?</p></article><article><small>02 / A DIRECTION</small><h2>Show the next<br />useful step.</h2><p>Collect references, then add the reasoning beside them.</p></article><article><small>03 / THE DECISION</small><h2>One visual brief.</h2><p>Compare the options together. Export a PNG or PDF to start the discussion.</p></article></div>
    </section>
    <footer><span>Capture → Arrange → Compare → Export</span><a href="https://github.com/kennylimkamho">Built by Kenny</a></footer>
  </main>
}
