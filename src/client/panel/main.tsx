import * as React from 'react'
import { createRoot } from 'react-dom/client'

import { PanelApp } from './App.js'
import './styles.css'

const container = document.getElementById('root')
if (container === null) {
  throw new Error('panel root element is missing')
}

createRoot(container).render(
  <React.StrictMode>
    <PanelApp />
  </React.StrictMode>,
)
