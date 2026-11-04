# NOTICE — 第三方素材与代码来源

本包是独立实现的插件，但**动画素材**来自 dsh-pet，按其许可证要求保留以下声明。

## 动画素材（assets/webm/*.webm）

来源：dsh-pet 0.3.8 —— https://github.com/PC2005-cloud/dsh-pet
许可：MIT License
版权：Copyright (c) dsh-pet contributors

本包从中挑选了 16 个动画文件（不改动内容，仅原样拷贝），用于驱动桌宠的
待机 / 拖拽 / 点击回应 / 小动作 / 工作状态 / 心情档位表现。
如需替换成自己的素材，把同名 `.webm`（VP9-alpha，建议 640×360）放进 `assets/webm/` 即可。

## 素材清单

| 文件 | 用途 |
| --- | --- |
| 待机呼吸休闲.webm | 待机 |
| 东张西望.webm | 转向 |
| 被鼠标拖拽悬空反馈.webm | 拖拽 |
| 点击回应-开心跃动.webm / 点击回应-元气挥手.webm | 点击回应 |
| 悠闲哼歌.webm / 超大伸懒腰.webm / 哈欠连天.webm / 写代码.webm / 鲸鱼吐泡泡特效.webm | 随机小动作 |
| 吃白饭.webm | 吃 |
| 原地小憩沉眠.webm | 低落档 |
| 工作状态-思考冒泡.webm / 工作状态-忙碌点按.webm / 工作状态-雀跃庆祝.webm / 工作状态-垂头叹气冒汗.webm | 心情档位 / 生成中 |

## 未拷贝的部分

dsh-pet 的 UI、物理引擎、配置系统、桌面 helper、余额功能均**未**沿用；
本包的宿主逻辑（lib/index.js、lib/brain.js）与浏览器渲染（lib/client.js）是重新实现的。
