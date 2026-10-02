import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import { ConfigProvider, App as AntdApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import 'antd/dist/reset.css';
import './styles/main.css';
import { appRoutes } from './router';

const theme = {
  token: {
    colorPrimary: '#7a1f1f',
    colorInfo: '#7a1f1f',
    colorSuccess: '#2f6f4f',
    colorWarning: '#c9963c',
    colorTextBase: '#2b1a12',
    borderRadius: 8,
    fontFamily:
      '"Songti SC", "Noto Serif SC", "Source Han Serif SC", "PingFang SC", "Microsoft YaHei", serif',
  },
  components: {
    Layout: { headerBg: '#fffdf8', siderBg: '#2b1a12' },
    Card: { headerBg: '#fffaf0' },
    Table: { headerBg: '#f9f1e2' },
  },
};

const container = document.getElementById('root');
if (!container) {
  throw new Error('未找到 #root 挂载节点');
}

/** 路由由 src/router/index.tsx 提供，App 负责整体布局与外层导航 */
const router = createBrowserRouter(appRoutes);

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={theme}>
      <AntdApp>
        <RouterProvider router={router} />
      </AntdApp>
    </ConfigProvider>
  </React.StrictMode>,
);
