/** Synthetic local protocol fixture. Never contacts AgentArts or any model. */
export function createContractTestProvider({ delay = 60 } = {}) {
  let calls = 0;
  return {
    kind: "contract-test",
    get calls() { return calls; },
    status() {
      return {
        configured: true,
        reason: "本地合成协议测试，未连接 AgentArts 或真实模型。",
        code: "CONTRACT_TEST_ONLY",
        runtimeName: "contract-test-runtime",
        applicationVersion: "synthetic-fixture-v1",
        maxCalls: 100,
      };
    },
    async invoke({ run, signal }) {
      calls += 1;
      const wait = run.request.question.includes("[wait]") ? 10000 : delay;
      await new Promise((resolve, reject) => {
        let timer;
        const abort = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          reject(Object.assign(new Error("本地合成协议测试已中断。"), { code: "CONTRACT_TEST_ABORTED" }));
        };
        if (signal?.aborted) return abort();
        timer = setTimeout(() => {
          signal?.removeEventListener("abort", abort);
          resolve();
        }, wait);
        signal?.addEventListener("abort", abort, { once: true });
      });
      if (run.request.question.includes("[needs_input]"))
        return {
          proposal: {
            schemaVersion: "xingjian.analysis-proposal.v1",
            decision: "needs_input",
            summary: "合成协议测试：需要先明确研究范围。",
            claims: [],
            tasks: [],
            gaps: ["这是合成结果，不是模型判断。"],
            questions: ["本次比较针对哪个时间范围？"],
          },
          platformRequestId: null,
        };
      return {
        proposal: {
          schemaVersion: "xingjian.analysis-proposal.v1",
          decision: "proposal",
          summary: "合成协议测试：以下候选仅用于验证引用与确认流程。",
          claims: [{
            id: "c1",
            text: "合成候选：访谈中提出需要补充采样资料。",
            evidenceIds: [run.request.question.includes("[invalid_evidence]") ? "ev-absent" : run.snapshot.evidence[0].id],
          }],
          tasks: [{ id: "t1", title: "合成行动：核对访谈范围并补充采样", claimIds: ["c1"] }],
          gaps: ["引用存在且位置匹配不代表原文支持候选结论。"],
          questions: [],
        },
        platformRequestId: null,
      };
    },
  };
}
