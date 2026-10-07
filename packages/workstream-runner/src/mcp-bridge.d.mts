export function openPilotMcp(
	clientRoot: string,
	signal: AbortSignal,
): Promise<{
	session: { verifiedPortal: { portalId: string } | null };
	connectionId: string;
	tools: {
		name: string;
		inputSchema?: {
			properties?: { objectIds?: { items?: { type?: string } } };
		};
	}[];
	call(
		tool: string,
		args: Record<string, unknown>,
	): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;
	close(): Promise<void>;
}>;
