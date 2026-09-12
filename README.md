# 成人共发性失调量表 · 自适应测评

这是成人共发性失调量表的浏览器端自适应测评页面。

**在线使用：** https://dysregulation-profile.github.io/adaptive-assessment-site/

## 项目说明

本页面在浏览器本地完成题目呈现、自适应选题、θ 参数估计与结果计算。

- 作答数据不会上传至服务器。
- 本次会话不会写入浏览器持久化存储；刷新或关闭页面后会话清空。
- 页面为静态站点，可直接通过 GitHub Pages 访问。
- 本测评仅供研究参考，结果不作为临床诊断。

本仓库是公开的 Pages 发布仓库。用于统计验证的 R/mirt reference、源 `.rds` 模型、回归测试和内部验证材料不属于该公开发布物。

## Third-party attribution

本项目的早期网页界面结构与部分 CSS 样式参考并改编自 [SBTI](https://github.com/pingfanfan/SBTI)，SBTI 采用 MIT License。

本项目的量表内容、IRT/GRM 模型、EAP 估计、自适应 CAT 选题与停止逻辑、风险分类、会话逻辑及统计验证均为本项目独立组件，并非来源于 SBTI。

SBTI 衍生部分的完整第三方许可声明见 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。

> SBTI 的 MIT License 仅适用于相应的 SBTI 衍生部分。本声明本身不构成对本项目其他独立组件授予 MIT License 或其他额外许可。
