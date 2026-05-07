# HK Momentum Breakout + Policy Catalyst

港股短线策略：只抓「量价共振 + 政策催化」突破机会。本目录为策略代码骨架，纯逻辑层完整可单测；行情、下单、政策抓取通过接口注入，默认提供 Futu OpenD 行情适配器骨架与手动政策催化输入器。

## 目录结构

```
hk-momentum-policy/
├── README.md
├── config.ts                  # 策略参数（成交量倍数、突破窗口、止盈止损、风控）
├── types.ts                   # 公共类型
├── indicators.ts              # SMA / EMA / RSI / MACD / 成交量均值
├── signal-engine.ts           # 量价突破信号检测
├── policy-agent.ts            # 3 智能体（News Grabber / Policy Analyst / Decision Executor）接口与默认实现
├── risk-manager.ts            # 仓位、单笔/单日风险、连亏熔断、回撤熔断
├── daily-report.ts            # 收盘后「执行报告」生成
├── market-data.ts             # MarketDataSource 接口
├── adapters/
│   └── futu-openapi.ts        # Futu OpenD 行情/下单适配器骨架
├── engine.ts                  # 策略协调器
├── index.ts                   # 导出入口
└── *.test.ts                  # 单测
```

## 关键参数（默认）

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `volumeMultiplier` | 1.5 | 当日量 ≥ 前 5 日均量的 1.5 倍 |
| `volumeLookback` | 5 | 量比基准窗口 |
| `breakoutSmaWindow` | 20 | 突破基准 SMA 周期 |
| `breakoutHighWindow` | 20 | 突破基准近 N 日高点 |
| `rsiThreshold` | 50 | RSI 必须 > 50 |
| `maxPositions` | 3 | 同时持仓不超过 3 只 |
| `perTradeRiskPct` | 0.025 | 单笔风险占总资金 2.5% |
| `dailyRiskCapPct` | 0.05 | 单日累计风险 5% |
| `stopLossPct` | 0.018 | 入场价下方 1.8% 止损（区间 1.5-2%）|
| `takeProfitPct` | 0.05 | 第一档 5% 止盈卖出 50% |
| `trailingMa` | 10 | 剩余仓位跟踪 10 日均线 |
| `consecLossPause` | 2 | 连续 2 天亏损当日停手 |
| `drawdownHaltPct` | 0.08 | 累计回撤 > 8% 清仓休息 3 天 |

## 3 智能体流程

`policy-agent.ts` 暴露 3 个接口，调用顺序固定：

1. `NewsGrabber.fetch(symbols, lookbackHours)` → `NewsItem[]`
2. `PolicyAnalyst.evaluate(news)` → `PolicyAssessment[]`（强/中/弱催化 + 受益板块）
3. `DecisionExecutor.decide(signals, assessments)` → `TradeDecision[]`（最终入场/观望）

默认实现：
- `ManualNewsGrabber`：从外部 JSON/CLI 输入加载，便于复盘回放与离线运行。
- `KeywordPolicyAnalyst`：基于关键词权重表打分（AI/算力/再贷款/中报/地产优化等）。
- `DefaultDecisionExecutor`：要求量价突破 ∧ 强催化 ∧ 受益板块匹配。

接入 LLM/富途新闻 API 时只需替换前两个实现，决策器与风控保持不变。

## 接入富途 OpenD

1. 本地启动 OpenD 网关（默认 `127.0.0.1:11111`）。
2. 安装 SDK（任选一）：
   - Node：`bun add futu-api`
   - 或自行实现 protobuf over websocket（本目录骨架预留扩展点）。
3. 配置 `.env`：
   ```
   FUTU_HOST=127.0.0.1
   FUTU_PORT=11111
   FUTU_TRD_ENV=SIMULATE   # SIMULATE 或 REAL
   FUTU_TRD_MARKET=HK
   FUTU_UNLOCK_PWD_MD5=    # 真实交易必填
   ```
4. 在入口处用 `FutuMarketDataSource` 替换默认的 `MockMarketDataSource`。

## 运行

```bash
bun x vitest run src/strategy/hk-momentum-policy
```

## 风控铁律（代码强制）

- 单笔仓位 ≤ 总资金 `perTradeRiskPct`，由 `risk-manager.ts#sizePosition` 计算。
- 单日累计风险触顶 → 当日 `canOpen()` 返回 false。
- 连续 2 日净亏 → 暂停新仓 1 个交易日。
- 累计回撤 > 8% → 清仓 + 冷静 3 个交易日。
- 止损位绝不上移；跟踪止盈仅向上推进。
