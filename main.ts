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

// Handle preflight for all routes
router.options("/(.*)", (ctx) => {
  ctx.response.headers.set("Access-Control-Allow-Origin", "*");
  ctx.response.headers.set(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );
  ctx.response.headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Accept"
  );
  ctx.response.status = 204;
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

// Set up middleware
app.use(router.routes());
app.use(router.allowedMethods());

// Start the server
await app.listen({ port: 8000 });
