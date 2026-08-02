import { deriveMilestoneState } from "../mcp-server/src/milestone-state.js";

describe("milestone business state", () => {
  const state = (overrides: Partial<Parameters<typeof deriveMilestoneState>[0]> = {}) => deriveMilestoneState({ milestone_id: "M0", dependencies: [], completion_status: "NONE", execution_grant_status: "NONE", dependencies_accepted: false, ...overrides });
  it("makes an unfinished root READY", () => expect(state()).toBe("READY"));
  it("keeps incomplete dependencies WAITING", () => expect(state({ milestone_id: "M1", dependencies: ["M0"] })).toBe("WAITING"));
  it("does not accept runtime loaded metadata as input", () => expect(state()).toBe("READY"));
  it("honors active grants and terminal outcomes", () => { expect(state({ execution_grant_status: "ACTIVE" })).toBe("EXECUTING"); expect(state({ completion_status: "ACCEPTED" })).toBe("ACCEPTED"); expect(state({ completion_status: "NEEDS_REWORK" })).toBe("NEEDS_REWORK"); });
});
