#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { QuiverAI } from "@quiverai/sdk";

const apiKey = process.env.QUIVERAI_API_KEY;
if (!apiKey) {
  console.error("Error: QUIVERAI_API_KEY environment variable is required");
  process.exit(1);
}

const quiver = new QuiverAI({ bearerAuth: apiKey });

const server = new Server(
  { name: "quiver-mcp", version: "0.1.1" },
  { capabilities: { tools: {} } }
);

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Narrow result to SvgResponse or throw a descriptive error. */
function assertSvgResponse(
  result: unknown
): asserts result is { data: Array<{ svg: string }> } {
  if (
    typeof result !== "object" ||
    result === null ||
    !("data" in result) ||
    !Array.isArray((result as Record<string, unknown>).data)
  ) {
    const err = result as { message?: string };
    throw new Error(
      `QuiverAI API error: ${err.message ?? JSON.stringify(result)}`
    );
  }
}

/** Narrow result to ListModelsResponse or throw. */
function assertListModels(
  result: unknown
): asserts result is {
  data: Array<{
    id: string;
    name?: string;
    description?: string;
    supportedOperations?: string[];
    pricing?: { prompt: string; completion: string };
  }>;
} {
  if (
    typeof result !== "object" ||
    result === null ||
    !("data" in result) ||
    !("object" in result)
  ) {
    const err = result as { message?: string };
    throw new Error(
      `QuiverAI API error: ${err.message ?? JSON.stringify(result)}`
    );
  }
}

/**
 * Write SVG(s) to disk. If `n > 1` and outputPath has no extension or ends in
 * `.svg`, each variant gets a `_1`, `_2` … suffix before the extension.
 * Returns the list of written file paths.
 */
async function writeSvgs(
  svgs: string[],
  outputPath: string
): Promise<string[]> {
  await mkdir(dirname(outputPath), { recursive: true });

  if (svgs.length === 1) {
    const p = outputPath.endsWith(".svg") ? outputPath : `${outputPath}.svg`;
    await writeFile(p, svgs[0], "utf-8");
    return [p];
  }

  const ext = extname(outputPath);
  const base = ext ? outputPath.slice(0, -ext.length) : outputPath;
  const suffix = ext || ".svg";

  const paths: string[] = [];
  for (let i = 0; i < svgs.length; i++) {
    const p = `${base}_${i + 1}${suffix}`;
    await writeFile(p, svgs[i], "utf-8");
    paths.push(p);
  }
  return paths;
}

// ── Tool definitions ───────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "generate_svg",
      description:
        "Generate one or more SVGs from a text prompt using QuiverAI. Returns raw SVG markup.\n\n" +
        "## Prompt guide\n\n" +
        "A good prompt has three parts: **subject** (specific object), **style** (aesthetic keywords), and **color palette** (hex codes if possible).\n\n" +
        "### What works\n" +
        "- Use concrete, famous physical objects the model has seen (AirPods, Nike Dunks, Shure SM7B, Montblanc pen, Leica camera, Nest thermostat, espresso machines). " +
        "Cylindrical/round objects explode especially cleanly in isometric style.\n" +
        "- Name the style explicitly: 'line art', 'hand drawn', 'duotone', 'flat monochrome icon', 'geometric', 'minimalist', 'isometric', 'blueprint'.\n" +
        "- Specify colors with hex codes: 'background: #e9edc9 and logo in #fb8500'.\n" +
        "- Add composition framing: 'centered icon', 'wide horizontal logo'.\n" +
        "- Prompt modifiers: 'geometric' → angular shapes, 'detailed' → more elements, 'simple' → clearer shapes, 'minimalist' → fewer details, 'flat monochrome' → single-color, 'duotone' → two-color.\n\n" +
        "### What does NOT work\n" +
        "- NEVER mention 'AI', 'machine learning', 'voice assistant', 'workflow automation', or abstract software concepts — produces garbage. Use physical metaphors instead (microphone for voice, watch movement for precision).\n" +
        "- Abstract concepts without physical objects: 'knowledge graph', 'automation pipeline', 'data flow'.\n" +
        "- Obscure B2B hardware the model hasn't seen (e.g. Loxone Miniserver → generic blob).\n" +
        "- 'minimalist line icon' constraints — model ignores them and fills with color.\n\n" +
        "### Iteration strategy\n" +
        "Start specific, not vague. Bad: 'Tech logo'. Better: 'Tech startup logo with geometric shapes, blue gradient'. " +
        "Best: 'SaaS productivity logo with connected geometric nodes, electric blue to purple gradient, clean modern style'.\n\n" +
        "### Verified template\n" +
        "`exploded isometric view of a {FAMOUS_OBJECT}, technical blueprint drawing, thin line art, dotted grid background, labeled components, engineering illustration`\n\n" +
        "### Known issues\n" +
        "- ~1 in 10 generations have corrupted SVG tails (malformed XML). Generate 3+ variants as insurance.\n" +
        "- Model may ignore 'no fills'/'monochrome' and hardcode its own palette. Post-process with find/replace for brand colors.\n" +
        "- First call may 504 — retry succeeds.",
      inputSchema: {
        type: "object",
        required: ["prompt", "model"],
        properties: {
          prompt: {
            type: "string",
            description:
              "WHAT to generate. Be specific: name a concrete famous object, add style keywords, and specify colors with hex codes. " +
              "Example: 'Heraldic lion crest with ornate medieval style details and gold gradient accents'. " +
              "Never use abstract concepts like 'AI agent' or 'workflow' — use physical metaphors instead.",
          },
          model: {
            type: "string",
            description:
              "Model ID to use. Recommended: 'arrow-1.1' (newest, cheapest at 20 credits/gen). Other options: 'arrow-1' (Arrow 1.0, 30 credits), 'arrow-1.1-max' (higher quality, 25 credits). Use list_models to discover available models.",
          },
          instructions: {
            type: "string",
            description:
              "HOW it should look — style guidance separate from the subject. Think of prompt as 'what' and instructions as 'how'. " +
              "Example: prompt='Japanese crane', instructions='Use a warm muted palette with detailed feather work'.",
          },
          n: {
            type: "number",
            description:
              "Number of SVG variants to generate (max 16). Recommended: 3+ at higher temperature for best results, since ~1 in 10 generations can have corrupted tails.",
          },
          temperature: {
            type: "number",
            description:
              "Sampling temperature (0–2). Lower (0.4) = more consistent, higher (0.9) = more creative variation. Use 0.9 with n≥3 for exploration.",
          },
          references: {
            type: "array",
            description:
              "Up to 4 reference images for style, color, and composition guidance. " +
              "References pull palette/color hints from the image, but style keywords ('blueprint', 'isometric', 'flat') must still be in the text prompt — references alone won't change drawing style.",
            items: {
              type: "object",
              oneOf: [
                {
                  required: ["url"],
                  properties: {
                    url: {
                      type: "string",
                      description: "HTTP/HTTPS image URL.",
                    },
                  },
                },
                {
                  required: ["base64"],
                  properties: {
                    base64: {
                      type: "string",
                      description: "Base64-encoded image data.",
                    },
                  },
                },
              ],
            },
          },
          outputPath: {
            type: "string",
            description:
              "Optional absolute file path to save the SVG(s) to disk. " +
              "If omitted, SVG markup is returned in the response only. " +
              "For multiple variants (n > 1), files are saved with _1, _2 … suffixes. " +
              "Parent directories are created automatically.",
          },
        },
      },
    },
    {
      name: "vectorize_svg",
      description:
        "Convert a raster image (PNG, JPG, etc.) into an SVG using QuiverAI. " +
        "Provide the image as a URL or base64-encoded string.",
      inputSchema: {
        type: "object",
        required: ["model", "image"],
        properties: {
          model: {
            type: "string",
            description:
              "Model ID to use. Use list_models to find models that support svg_vectorize.",
          },
          image: {
            type: "object",
            description: "The image to vectorize — either a URL or base64 data.",
            oneOf: [
              {
                required: ["url"],
                properties: {
                  url: { type: "string", description: "HTTP/HTTPS image URL." },
                },
              },
              {
                required: ["base64"],
                properties: {
                  base64: {
                    type: "string",
                    description: "Base64-encoded image data.",
                  },
                },
              },
            ],
          },
          autoCrop: {
            type: "boolean",
            description:
              "Auto-crop to the dominant subject before vectorizing. Defaults to false.",
          },
          targetSize: {
            type: "number",
            description: "Square resize target in pixels before vectorizing.",
          },
          temperature: {
            type: "number",
            description: "Sampling temperature (0–2). Defaults to 1.",
          },
          outputPath: {
            type: "string",
            description:
              "Optional absolute file path to save the vectorized SVG to disk. " +
              "If omitted, SVG markup is returned in the response only. " +
              "Parent directories are created automatically.",
          },
        },
      },
    },
    {
      name: "list_models",
      description:
        "List all models available on QuiverAI, including supported operations " +
        "(svg_generate, svg_vectorize, etc.) and pricing.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ],
}));

// ── Tool handlers ──────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "generate_svg") {
    const { prompt, model, instructions, n, temperature, references, outputPath } =
      args as {
        prompt: string;
        model: string;
        instructions?: string;
        n?: number;
        temperature?: number;
        references?: Array<{ url?: string; base64?: string }>;
        outputPath?: string;
      };

    const response = await quiver.createSVGs.generateSVG({
      prompt,
      model,
      instructions,
      n,
      temperature,
      stream: false,
      references: references?.map((ref) =>
        ref.url !== undefined
          ? { url: ref.url }
          : { base64: ref.base64! }
      ),
    });

    const result = response.result;
    assertSvgResponse(result);

    const rawSvgs = result.data.map((d) => d.svg);
    const content = rawSvgs.map((svg, i) => ({
      type: "text" as const,
      text: n && n > 1 ? `<!-- SVG ${i + 1} -->\n${svg}` : svg,
    }));

    if (outputPath) {
      const paths = await writeSvgs(rawSvgs, outputPath);
      content.push({
        type: "text" as const,
        text: `Saved to: ${paths.join(", ")}`,
      });
    }

    return { content };
  }

  if (name === "vectorize_svg") {
    const { model, image, autoCrop, targetSize, temperature, outputPath } = args as {
      model: string;
      image: { url?: string; base64?: string };
      autoCrop?: boolean;
      targetSize?: number;
      temperature?: number;
      outputPath?: string;
    };

    const imageRef =
      image.url !== undefined
        ? { url: image.url }
        : { base64: image.base64! };

    const response = await quiver.vectorizeSVG.vectorizeSVG({
      model,
      image: imageRef,
      autoCrop,
      targetSize,
      temperature,
      stream: false,
    });

    const result = response.result;
    assertSvgResponse(result);

    const svg = result.data[0].svg;
    const content: Array<{ type: "text"; text: string }> = [
      { type: "text", text: svg },
    ];

    if (outputPath) {
      const paths = await writeSvgs([svg], outputPath);
      content.push({ type: "text", text: `Saved to: ${paths.join(", ")}` });
    }

    return { content };
  }

  if (name === "list_models") {
    const response = await quiver.models.listModels();
    const result = response.result;
    assertListModels(result);

    const formatted = result.data
      .map((m) => {
        const ops = m.supportedOperations?.join(", ") ?? "—";
        const price = m.pricing
          ? `prompt: ${m.pricing.prompt} / completion: ${m.pricing.completion}`
          : "—";
        return (
          `**${m.id}**${m.name ? ` (${m.name})` : ""}` +
          `\n  operations: ${ops}` +
          `\n  pricing: ${price}` +
          (m.description ? `\n  ${m.description}` : "")
        );
      })
      .join("\n\n");

    return {
      content: [{ type: "text" as const, text: formatted }],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

// ── Start ──────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
