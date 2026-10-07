import { defineDoc } from "@earendil-works/pi-durable";

export type TraceRecord = {
	tool: string;
	pid: number;
	at: string;
};

export type InvestigationState = {
	executions: TraceRecord[];
	steps: TraceRecord[];
};

export const InvestigationDoc = defineDoc<InvestigationState>({
	kind: "app.investigation",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ executions: [], steps: [] }),
});
