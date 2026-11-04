# egern-komari-widget

Komari 面板专用的 Egern 小组件仓库。把 [Komari Monitor](https://github.com/komari-monitor/komari) 的节点状态搬上 iOS 主屏：在线状态、CPU / 内存 / 磁盘、三网延迟（移动 / 联通 / 电信）、实时网速、累计流量、价格与到期天数。

## 小组件列表

### <img src="icons/komari-panel.svg" width="26" valign="middle" alt="Komari 面板图标"> Komari 面板

三种尺寸自适应：小尺寸显示第一台（优先在线）节点详情，中尺寸显示节点列表，大尺寸显示带进度条的明细。

模块远程引用链接（推荐：在 Egern 里添加**模块**时用这个，自带中文参数表单）：

```
https://raw.githubusercontent.com/Yin886/egern-komari-widget/main/komari-panel.yaml
```

脚本远程引用链接（添加**远程小组件**时用这个，参数以环境变量形式填写）：

```
https://raw.githubusercontent.com/Yin886/egern-komari-widget/main/komari-panel.js
```

## 参数说明

| 参数 | 说明 |
| --- | --- |
| 面板地址 | Komari 面板根地址，如 `https://panel.example.com:8443`，只填根地址，不要带 `/admin` 或 `/api` |
| 请求策略 | 请求走哪个代理策略或策略组（如 `Proxy`）；留空走默认规则 |
| 登录令牌（私有站点） | 后台登录得到的令牌，与账号密码二选一；公开站点留空 |
| 后台账号 / 密码（私有站点） | 填了脚本每次刷新会自动登录换令牌；公开站点留空 |
| 只显示这些服务器 | 名称或 ID，英文逗号分隔；留空显示全部 |
| 显示隐藏的服务器 | 是否显示面板里被隐藏的服务器，默认否 |

脚本直加时对应的环境变量：`PANEL`、`POLICY`、`TOKEN`、`USER`、`PASS`、`ONLY`、`SHOW_HIDDEN`，另有可选项 `TITLE`（标题）和 `REFRESH`（刷新间隔分钟，默认 15）。

## 数据来源

只用 Komari 的公开接口：`/api/nodes`、`/api/recent/{uuid}`、`/api/records/ping?uuid=`。在线判定与面板一致（最新上报 5 分钟内）；三网延迟取面板 Ping 任务的窗口均值，名称含 v6 的移动任务不作为「移动」展示。
