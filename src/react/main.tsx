import './polyfills/buffer';
import ReactDOM from 'react-dom/client';
import './util/vscode.js';
import { getConfigs } from './util/vscodeConfig.ts';
import './main.css'
import { ConfigProvider } from 'antd';
import { lazy } from 'react';
import { antThemeConfig } from './antThemeConfig.ts';
const Excel = lazy(() => import('./view/excel/Excel.tsx'))
const Word = lazy(() => import('./view/word/Word.tsx'))

document.getElementById('_defaultStyles')?.parentNode?.removeChild(document.getElementById('_defaultStyles'))
const configs = getConfigs();

export default function App() {
  const route = configs?.route
  switch (route) {
    case 'excel':
      return <Excel />
    case 'word':
      return <Word />
    default:
      return <>Office Viewer (Hardened)</>
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <ConfigProvider
    componentSize='small'
    theme={antThemeConfig}
  >
    <App />
  </ConfigProvider>
)
