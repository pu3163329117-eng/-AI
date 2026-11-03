import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { RenderBoundary } from './components/RenderBoundary'
import { ConnectionStatus } from './components/ConnectionStatus'
import './styles.css'
import './inkroomFormal.css'
import './inkroomPages.css'
import './waterink.css'
import './waterinkEntry.css'
import './waterinkStudy.css'
import './waterinkAdmin.css'
import './motion/inkMotionIntegration.css'
import './feedbackLayout.css'
import './guidedStudy.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div className="waterink-theme waterink-root"><RenderBoundary><ConnectionStatus /><App /></RenderBoundary></div>
  </StrictMode>,
)
