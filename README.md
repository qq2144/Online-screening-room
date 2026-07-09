# 🎬 私人放映厅 (Online Screening Room)

一个跑在你自己 VPS 上的在线播放器，两个人可以**同步观影**：一方
播放 / 暂停 / 拖进度，另一方会自动跟着同步，还带一个文字聊天框。

- 视频通过 HTTP Range 流式播放（可拖进度条、边看边缓冲）
- 播放控制通过 WebSocket（Socket.IO）实时同步
- 房间号 + 密码，只有你俩能进
- 网页直接上传电影（带进度条），不用再手动 scp
- 附带影片列表和文字聊天

你的 VPS: ``

---

## 在 VPS 上部署

### 1. 装 Node.js (>=18)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2. 拉代码并安装依赖

```bash
git clone <你的仓库地址> screening-room
cd screening-room
npm install
```

### 3. 放电影进 media/ 目录

浏览器只能直接播 **H.264(MP4) + AAC** 编码。`.mkv` / HEVC 等需要先转：

```bash
# 转封装（快，编码本来就兼容时用）
ffmpeg -i 电影.mkv -c copy -movflags +faststart media/movie.mp4

# 重新编码（编码不兼容时用，较慢）
ffmpeg -i 电影.mkv -c:v libx264 -c:a aac -movflags +faststart media/movie.mp4
```

`-movflags +faststart` 很重要：把索引放到文件头，网页秒开、能拖动。

**上传方式一：网页上传（推荐）** — 进入放映厅后，侧栏「上传新影片」选文件点上传，
带进度条，完成后自动通知对方刷新片单。默认单文件最大 30GB，可用环境变量调整：

```bash
export MAX_UPLOAD_GB=50   # 想改上限就设置这个，默认 30
```

**上传方式二：scp（大文件/网络不稳定时更可靠）**

```bash
scp "我的电影.mp4" root@REDACTED_IP:~/screening-room/media/
```

> 网页上传是单次 HTTP 请求，没有断点续传。电影很大 (10GB+) 又是移动网络/
> WiFi 不稳定的情况下，建议还是用 scp，或者转好码后再传。

### 4. 设置密码并启动

```bash
export SCREENING_PASSWORD='你俩的暗号'
npm start
```

想让它开机自启、崩溃自动重启，用 PM2：

```bash
sudo npm install -g pm2
# 先在 ecosystem.config.cjs 里改好密码
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # 按提示执行它输出的那行命令
```

### 5. 开放端口

在阿里云安全组（以及服务器防火墙）放行 **3000** 端口的入站。

### 6. 访问

你和女友都打开：

```
http://REDACTED_IP:3000
```

输入**相同的房间号**和**密码**，选一部片子点「加载并同步给对方」，
再点画面上的「▶ 一起开始」即可。

---

## ⚠️ 关于 HTTPS（建议尽快加）

现在是纯 HTTP。用 IP 访问功能可用，但：
- 浏览器可能提示「不安全」
- 没有加密，同一网络里理论上能被看到

**等你买了域名**（把域名 A 记录指向 `REDACTED_IP`），换成 Caddy 一步搞定
免费 HTTPS。届时告诉我域名，我给你补一个 `Caddyfile`，大致是：

```
your-domain.com {
    reverse_proxy localhost:3000
}
```

Caddy 会自动申请并续期 Let's Encrypt 证书。

---

## 上传保障

网页上传接口 (`POST /api/upload`) 加了几层保护，避免被滥用或误操作：

| 保障 | 说明 |
|---|---|
| 密码校验 | 上传请求必须带正确的房间密码，10 次错误后锁定 1 分钟 |
| 格式白名单 | 只接受 `.mp4` / `.webm` / `.m4v` / `.mov`，其他一律拒绝 |
| 大小限制 | 默认单文件 30GB，超过直接拒绝（`MAX_UPLOAD_GB` 可调） |
| 磁盘空间检查 | 上传前用 `df` 检查剩余空间，不够就直接拒绝，避免撑爆硬盘 |
| 并发上锁 | 同一时间只接受一个上传，避免两人同时传导致 I/O 打架 |
| 文件名安全处理 | 只取文件名本身（防止 `../../` 路径穿越），重名自动加 `(1)` 后缀，不会覆盖已有电影 |
| 失败自动清理 | 上传中断/超限/校验失败时，写了一半的临时文件会自动删除 |

上传成功后会通过 WebSocket 通知房间里的另一个人，片单自动刷新，不用手动刷新页面。

---

## 目录结构

```
├─ server/
│  ├─ index.js      # Express + Socket.IO 服务
│  └─ rooms.js      # 房间状态
├─ public/          # 前端播放器页面
│  ├─ index.html
│  ├─ player.js     # 播放器 + 同步逻辑
│  └─ style.css
├─ media/           # 放电影（不提交进 git）
└─ ecosystem.config.cjs  # PM2 配置
```

## 常见问题

- **进度条不能拖 / 秒开慢** → 加 `-movflags +faststart` 重新处理文件。
- **画面黑屏、声音正常或整段播不了** → 编码不兼容，用上面的重新编码命令转 H.264。
- **两边差几秒** → 正常，每 3 秒会自动校正一次（偏差 >1s 才纠正）。
- **点了没自动播放** → 浏览器限制，需要手动点一下「▶ 一起开始」。
