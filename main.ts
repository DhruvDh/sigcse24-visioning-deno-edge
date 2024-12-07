// THIS EDGE FUNCTION IS DEPLOYED AT https://near-duck-52.deno.dev/

import OpenAI from "openai";
import { Application } from "jsr:@oak/oak/application";
import { Router } from "jsr:@oak/oak/router";

const openai = new OpenAI({
  baseURL: "https://api.deepinfra.com/v1/openai",
  apiKey: Deno.env.get("DEEPINFRA_API_KEY"),
});

const modelName =
  Deno.env.get("MODEL_NAME") || "meta-llama/Llama-3.3-70B-Instruct-Turbo";

const app = new Application();
const router = new Router();

// Define interface for our responses
interface OnboardingResponse {
  name: string;
  timestamp: number;
  responses: {
    teachLLMs: string;
    syntheticStudents: string;
  };
}

// Open KV database
const kv = await Deno.openKv();

router.options("/(.*)", (ctx) => {
  ctx.response.headers.set("Access-Control-Allow-Origin", "*");
  ctx.response.headers.set(
    "Access-Control-Allow-Methods",
    "GET, POST, DELETE, OPTIONS"
  );
  ctx.response.headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Accept"
  );
  ctx.response.status = 204;
});

// Add new endpoint for storing responses
router.post("/responses", async (ctx) => {
  ctx.response.headers.set("Access-Control-Allow-Origin", "*");

  try {
    const body = await ctx.request.body.json();
    const { name, responses } = body;

    if (!responses || typeof responses !== "object") {
      ctx.response.status = 400;
      ctx.response.body = { error: "Invalid response format" };
      return;
    }

    const response: OnboardingResponse = {
      name,
      timestamp: Date.now(),
      responses: {
        teachLLMs: responses.teachLLMs || "",
        syntheticStudents: responses.syntheticStudents || "",
      },
    };

    // Store in KV with timestamp-based key for ordering
    // Using ["responses", timestamp, name] allows us to list by timestamp
    await kv.set(["responses", response.timestamp, name], response);

    ctx.response.status = 200;
    ctx.response.body = { success: true };
  } catch (error) {
    console.error("Error storing response:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

// Add new endpoint for fetching responses with options
router.get("/responses", async (ctx) => {
  ctx.response.headers.set("Access-Control-Allow-Origin", "*");

  try {
    const url = new URL(ctx.request.url);
    const params = {
      limit: parseInt(url.searchParams.get("limit") || "100"),
      offset: parseInt(url.searchParams.get("offset") || "0"),
      since: parseInt(url.searchParams.get("since") || "0"), // timestamp
      name: url.searchParams.get("name"), // optional name filter
    };

    const responses = [];
    const iter = kv.list({ prefix: ["responses"] });
    let skipped = 0;
    let included = 0;

    for await (const entry of iter) {
      const response = entry.value as OnboardingResponse;
      
      // Apply filters
      if (params.since && response.timestamp < params.since) continue;
      if (params.name && response.name !== params.name) continue;
      
      // Handle pagination
      if (skipped < params.offset) {
        skipped++;
        continue;
      }
      
      if (included >= params.limit) break;
      
      responses.push({
        ...response,
        key: entry.key, // Include the KV key for reference
      });
      
      included++;
    }

    // Add metadata to response
    ctx.response.body = {
      responses,
      metadata: {
        limit: params.limit,
        offset: params.offset,
        count: responses.length,
        filters: {
          since: params.since || null,
          name: params.name || null,
        }
      }
    };

  } catch (error) {
    console.error("Error fetching responses:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

// Add endpoint to get response statistics
router.get("/responses/stats", async (ctx) => {
  ctx.response.headers.set("Access-Control-Allow-Origin", "*");

  try {
    const stats = {
      total: 0,
      uniqueNames: new Set<string>(),
      timeRange: {
        first: Infinity,
        last: 0,
      },
    };

    const iter = kv.list({ prefix: ["responses"] });
    for await (const entry of iter) {
      const response = entry.value as OnboardingResponse;
      stats.total++;
      stats.uniqueNames.add(response.name);
      stats.timeRange.first = Math.min(stats.timeRange.first, response.timestamp);
      stats.timeRange.last = Math.max(stats.timeRange.last, response.timestamp);
    }

    ctx.response.body = {
      total: stats.total,
      uniqueParticipants: stats.uniqueNames.size,
      timeRange: {
        first: stats.timeRange.first === Infinity ? null : stats.timeRange.first,
        last: stats.timeRange.last === 0 ? null : stats.timeRange.last,
        durationMs: stats.timeRange.last - stats.timeRange.first,
      }
    };

  } catch (error) {
    console.error("Error getting response stats:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

// Define the streaming handler
router.post("/chat", async (ctx) => {
  ctx.response.headers.set("Access-Control-Allow-Origin", "*");

  try {
    // Get request body - fixed body parsing
    const body = await ctx.request.body.json();
    const { messages } = body;

    if (!messages || !Array.isArray(messages)) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Invalid messages format" };
      return;
    }

    // Set up SSE headers
    ctx.response.headers.set("Content-Type", "text/event-stream");
    ctx.response.headers.set("Cache-Control", "no-cache");
    ctx.response.headers.set("Connection", "keep-alive");

    // Create chat completion with streaming
    const stream = await openai.chat.completions.create({
      model: modelName,
      messages,
      stream: true,
    });

    // Set up streaming response
    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content;
            if (content) {
              controller.enqueue(encoder.encode(`data: ${content}\n\n`));
            }
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch (error) {
          console.error("Stream reading error:", error);
          controller.error(error);
        } finally {
          controller.close();
        }
      },
    });

    ctx.response.body = readable;
  } catch (error) {
    console.error("Error in chat endpoint:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

// Add endpoint to delete responses by name
router.delete("/responses/:name", async (ctx) => {
  ctx.response.headers.set("Access-Control-Allow-Origin", "*");

  try {
    const name = ctx.params.name;
    if (!name) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Name parameter is required" };
      return;
    }

    // Find all entries for this name
    const iter = kv.list({ prefix: ["responses"] });
    const deleteOps = [];
    let count = 0;

    for await (const entry of iter) {
      const response = entry.value as OnboardingResponse;
      if (response.name === name) {
        deleteOps.push(kv.delete(entry.key));
        count++;
      }
    }

    // Execute all deletes
    await Promise.all(deleteOps);

    ctx.response.body = { 
      success: true, 
      deleted: count,
      message: `Deleted ${count} responses for ${name}`
    };

  } catch (error) {
    console.error("Error deleting responses:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

// Set up middleware
app.use(router.routes());
app.use(router.allowedMethods());

// Start the server
await app.listen({ port: 8000 });
