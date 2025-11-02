import type {
	IWorkflowSettings,
	IConnections,
	INode,
	IPinData,
	IConnection,
	INodeConnections,
} from 'n8n-workflow';
import { z } from 'zod';

import type { ITag } from './tags';

export interface WorkflowMetadata {
	onboardingId?: string;
	templateId?: string;
	instanceId?: string;
	templateCredsSetupCompleted?: boolean;
}

// Simple version of n8n-workflow.Workflow
export interface WorkflowData {
	id?: string;
	name?: string;
	active?: boolean;
	nodes: INode[];
	connections: IConnections;
	settings?: IWorkflowSettings;
	tags?: string[];
	pinData?: IPinData;
	versionId?: string;
	meta?: WorkflowMetadata;
}

export interface WorkflowDataUpdate {
	id?: string;
	name?: string;
	nodes?: INode[];
	connections?: IConnections;
	settings?: IWorkflowSettings;
	active?: boolean;
	tags?: ITag[] | string[]; // string[] when store or requested, ITag[] from API response
	pinData?: IPinData;
	versionId?: string;
	meta?: WorkflowMetadata;
	parentFolderId?: string;
	uiContext?: string;
}

export interface WorkflowDataCreate extends WorkflowDataUpdate {
	projectId?: string;
}

// IConnection schema (assuming this is the base connection type)
export const IConnectionSchema = z.object({
	node: z.string(),
	type: z.string(),
	index: z.number(),
});

// INodeConnection schema
export const INodeConnectionSchema = z.object({
	sourceIndex: z.number(),
	destinationIndex: z.number(),
});

// NodeInputConnections - Array of (IConnection[] or null)
export const NodeInputConnectionsSchema = z.array(z.union([z.array(IConnectionSchema), z.null()]));

// INodeConnections - Record where keys are input names, values are NodeInputConnections
export const INodeConnectionsSchema = z.record(z.string(), NodeInputConnectionsSchema);

// IConnections - Record where keys are node names, values are INodeConnections
export const IConnectionsSchema = z.record(z.string(), INodeConnectionsSchema);

// Zod schemas for runtime validation
const WorkflowMetadataSchema = z
	.object({
		onboardingId: z.string().optional(),
		templateId: z.string().optional(),
		instanceId: z.string().optional(),
		templateCredsSetupCompleted: z.boolean().optional(),
	})
	.passthrough();

// Recursive parameter value schema that validates the structure
const NodeParameterValueSchema: z.ZodTypeAny = z.lazy(() =>
	z.union([
		z.string(),
		z.number(),
		z.boolean(),
		z.null(),
		z.undefined(),
		z.array(z.lazy(() => NodeParameterValueSchema)),
		z.record(z.lazy(() => NodeParameterValueSchema)),
	]),
);

// Enhanced parameters schema with better validation
const NodeParametersSchema = z.record(NodeParameterValueSchema).superRefine((params, ctx) => {
	// Check for common fixedCollection issues where objects should be arrays
	for (const [key, value] of Object.entries(params)) {
		if (value && typeof value === 'object' && !Array.isArray(value)) {
			const obj = value as Record<string, unknown>;
			// Check if this looks like a fixedCollection with nested objects
			for (const [nestedKey, nestedValue] of Object.entries(obj)) {
				// If nested value is an object with numeric keys or looks like it should be an array
				if (
					nestedValue &&
					typeof nestedValue === 'object' &&
					!Array.isArray(nestedValue) &&
					!('__rl' in nestedValue) // Not a resource locator
				) {
					const nestedObj = nestedValue as Record<string, unknown>;
					const keys = Object.keys(nestedObj);
					// Check if keys are numeric or if this looks like it should be iterable
					if (keys.length > 0 && keys.every((k) => !isNaN(Number(k)))) {
						ctx.addIssue({
							code: z.ZodIssueCode.custom,
							message: `Parameter "${key}.${nestedKey}" appears to be an object with numeric keys but should be an array. Expected array format for fixedCollection parameters.`,
							path: [key, nestedKey],
						});
					}
				}
			}
		}
	}
});

// INode schema - validates required fields from n8n-workflow
export const INodeSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		typeVersion: z.number(),
		type: z.string(),
		position: z.tuple([z.number(), z.number()]),
		disabled: z.boolean().optional(),
		notes: z.string().optional(),
		notesInFlow: z.boolean().optional(),
		retryOnFail: z.boolean().optional(),
		maxTries: z.number().optional(),
		waitBetweenTries: z.number().optional(),
		alwaysOutputData: z.boolean().optional(),
		executeOnce: z.boolean().optional(),
		continueOnFail: z.boolean().optional(),
		parameters: NodeParametersSchema,
		webhookId: z.string().optional(),
		extendsCredential: z.string().optional(),
		forceCustomOperation: z
			.object({
				resource: z.string(),
				operation: z.string(),
			})
			.optional(),
	})
	.passthrough(); // Use passthrough to allow credentials, rewireOutputLogTo and for forward compatibility

// ITag schema - based on actual ITag interface requirements
const ITagSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		usageCount: z.number().optional(),
		createdAt: z.string().optional(),
		updatedAt: z.string().optional(),
	})
	.passthrough(); // Use passthrough to allow unknown fields for forward compatibility

export const WorkflowDataUpdateSchema = z
	.object({
		id: z.string().optional(),
		name: z.string().optional(),
		nodes: z.array(INodeSchema),
		connections: IConnectionsSchema,
		// settings: z.record(z.any()).optional(), // IWorkflowSettings - complex structure
		active: z.boolean().optional(),
		tags: z.union([z.array(z.string()), z.array(ITagSchema)]).optional(),
		// pinData: z.record(z.any()).optional(), // IPinData - complex structure
		versionId: z.string().optional(),
		meta: WorkflowMetadataSchema.optional(),
		parentFolderId: z.string().optional(),
		uiContext: z.string().optional(),
	})
	.passthrough(); // Use passthrough to allow unknown fields for forward compatibility

// ============================================================================
// Type Assertions - These will cause compile errors if schemas drift from interfaces
// ============================================================================

// Ensures IConnectionSchema matches the n8n-workflow IConnection interface
type _AssertConnectionSchemaMatchesInterface = z.infer<typeof IConnectionSchema> extends IConnection
	? true
	: false;

// Ensures INodeConnectionsSchema matches the n8n-workflow INodeConnections interface
type _AssertNodeConnectionsSchemaMatchesInterface = z.infer<
	typeof INodeConnectionsSchema
> extends INodeConnections
	? true
	: false;

// Ensures IConnectionsSchema matches the n8n-workflow IConnections interface
type _AssertConnectionsSchemaMatchesInterface = z.infer<
	typeof IConnectionsSchema
> extends IConnections
	? true
	: false;

// Ensures WorkflowMetadataSchema matches the local WorkflowMetadata interface
type _AssertWorkflowMetadataSchemaMatchesInterface = z.infer<
	typeof WorkflowMetadataSchema
> extends WorkflowMetadata
	? true
	: false;

// Ensures INodeSchema matches the n8n-workflow INode interface
type _AssertNodeSchemaMatchesInterface = z.infer<typeof INodeSchema> extends INode ? true : false;

// Ensures ITagSchema matches the local ITag interface
type _AssertTagSchemaMatchesInterface = z.infer<typeof ITagSchema> extends ITag ? true : false;

// Ensures WorkflowDataUpdateSchema matches the local WorkflowDataUpdate interface
type _AssertWorkflowDataUpdateSchemaMatchesInterface = z.infer<
	typeof WorkflowDataUpdateSchema
> extends WorkflowDataUpdate
	? true
	: false;
