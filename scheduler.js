/**
 * 检索调度器：只看这一轮用户说了什么，决定「查多深」。
 * 规则是本地确定性的，不调模型、不改记忆、不碰授权；存储层不知道预算档位。
 */

export const QUERY_TYPES = ['troubleshooting', 'procedure', 'exact_lookup', 'continuation', 'planning', 'generation', 'general'];

/** 档位只调候选深度与卡片数；字节上限仍由投递端的 1200 封顶。 */
export const TIERS = {
  low: { candidates: 4, cards: 1 },
  mid: { candidates: 8, cards: 2 },
  high: { candidates: 12, cards: 3 },
};

const TYPE_TIER = {
  exact_lookup: 'low',
  continuation: 'low',
  procedure: 'mid',
  generation: 'mid',
  troubleshooting: 'high',
  planning: 'high',
  general: 'mid',
};

/** 有先后顺序：越具体、越影响下一步的意图排越前，宽泛的词不能盖住明确的任务。 */
const TASK_RULES = [
  ['troubleshooting', /报错|错误|失败|崩了|崩溃|闪退|卡死|白屏|超时|不生效|没反应|怎么回事|排查|定位|\b(error|errors|failed|failure|crash(?:es|ed|ing)?|exception|timeout|broken|bug|bugs)\b/i],
  ['exact_lookup', /是哪个|哪个文件|哪一条|在哪里|在哪|路径|版本号|叫什么|多少|上次|之前说|还记得|查一下|\b(where|which|what version|path|previous|last time)\b/i],
  ['planning', /方案|规划|计划|设计|重构|架构|下一阶段|路线|取舍|怎么选|评估|\b(plans?|planning|design(?:s|ed|ing)?|architectures?|refactor(?:s|ed|ing)?|roadmaps?|trade-?offs?)\b/i],
  ['generation', /写一段|写个|生成|起草|文案|总结|翻译|改写|润色|\b(copy|draft(?:s|ed|ing)?|writ(?:e|es|ten|ing)|generat(?:e|es|ed|ing|ion)|summar(?:y|ies|ize|izes|ized|izing|ise|ises|ised|ising)|translat(?:e|es|ed|ing|ion)|rewrit(?:e|es|ten|ing))\b/i],
  ['procedure', /发布|发版|上线|部署|安装|升级|迁移|打包|提交|回滚|配置|接入|接入流程|步骤|\b(release|publish|deploy|install|migrat|rollback|setup|config)/i],
];

/** 续句只在没有更具体目标时才算续接：「继续评估重构方案」是新任务，不是接着上文。 */
const CONTINUATION = /继续|接着|刚才那|上面那|上一步|然后呢|\b(continue|go on|next step)\b/i;

/** 一句话判定任务类型；空查询不猜续接，交给普通档。 */
export function queryTypeOf(query) {
  const text = String(query || '').trim();
  if (!text) return 'general';
  for (const [type, rule] of TASK_RULES) if (rule.test(text)) return type;
  if (CONTINUATION.test(text)) return 'continuation';
  return 'general';
}

/** 这一轮的检索计划：类型、档位、候选深度、卡片上限。字节按档位给预算，但不超过 1200。 */
export function retrievalPlanOf(query, options = {}) {
  const type = QUERY_TYPES.includes(options.type) ? options.type : queryTypeOf(query);
  const tier = TYPE_TIER[type] || 'mid';
  const spec = TIERS[tier];
  const ceiling = Number.isFinite(options.cardMax) ? options.cardMax : 3;
  return {
    type,
    tier,
    candidates: spec.candidates,
    cards: Math.min(spec.cards, ceiling),
    bytes: tier === 'low' ? 400 : tier === 'mid' ? 800 : 1200,
  };
}

/** 给面板/回执用的一行摘要：只记类型与档位，不记用户原话。 */
export function planSummaryOf(plan) {
  if (!plan || !plan.type) return '';
  return `${plan.type} · ${plan.tier} · 候选 ${plan.candidates} · 卡片 ${plan.cards}`;
}
