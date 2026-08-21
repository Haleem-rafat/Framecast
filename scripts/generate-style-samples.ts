/**
 * Generates the style picker's samples. Run once; the output is committed.
 *
 *   pnpm tsx --conditions=react-server scripts/generate-style-samples.ts
 *   pnpm tsx --conditions=react-server scripts/generate-style-samples.ts doodle-marker
 *
 * ## Why one fixed subject
 *
 * The operator is choosing between *looks*, so the subject has to be the
 * constant. A different scene per card would ask them to compare two things at
 * once — which is the same mistake the doodle format's own A/B protocol was
 * rewritten to avoid, and it is easier to make here because a nicer scene in
 * one style reads as a nicer style.
 *
 * The subject below is deliberately dull and deliberately human: a figure at a
 * desk is drawable in all seven looks, needs no setting, and shows the one
 * thing an operator is actually judging — how this style draws a person.
 *
 * ## Why files rather than generation on demand
 *
 * Seven styles at about five cents is thirty-five cents, once, ever — not per
 * channel and not per view. Same reasoning `art-styles.ts` gives for being code
 * rather than database rows: the app ships with the catalogue whether or not a
 * seed has run, and the samples are part of the catalogue.
 *
 * ## Safe to run twice
 *
 * A style whose sample already exists is skipped and reported as unchanged, so
 * re-running after adding one entry costs one generation rather than seven.
 * Pass style ids as arguments to force just those.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ART_STYLES, composeArtStyle } from "@/lib/art-styles";
import { gatewayImageProvider } from "@/services/providers/image.provider";

/** Where the picker looks. Kept in step with `sampleSrc` in branding-form.tsx,
 *  which builds `/art-styles/<id>.webp` from the same slug. */
const OUTPUT_DIR = join(process.cwd(), "public", "art-styles");

/**
 * The one subject every sample draws.
 *
 * Written as a scene rather than as a character, because half the catalogue
 * holds a character and half deliberately does not — a brief naming hair and
 * clothing would flatter the illustrated styles and mean nothing to the doodle
 * one.
 */
const SUBJECT =
  "A single person sitting at a desk, side on, with a cup beside them and one " +
  "hand resting on the desk. Plain background.";

/** 3:2, matching the picker card's aspect ratio, so no sample is cropped in
 *  the grid. The same shape `ILLUSTRATION_SIZE` asks for in landscape. */
const SAMPLE_SIZE = "1536x1024" as const;

async function main(): Promise<void> {
  const only = new Set(process.argv.slice(2));
  const wanted = ART_STYLES.filter((style) => only.size === 0 || only.has(style.id));

  if (wanted.length === 0) {
    console.error(
      `No style matched ${[...only].join(", ")}. Known ids: ` +
        ART_STYLES.map((style) => style.id).join(", "),
    );
    process.exitCode = 1;
    return;
  }

  await mkdir(OUTPUT_DIR, { recursive: true });

  for (const style of wanted) {
    const path = join(OUTPUT_DIR, `${style.id}.webp`);

    if (existsSync(path) && only.size === 0) {
      console.log(`unchanged  ${style.id} (delete the file or pass its id to redraw)`);
      continue;
    }

    const image = await gatewayImageProvider.generate({
      prompt: [
        "Draw one sample illustration.",
        "",
        `The scene: ${SUBJECT}`,
        "",
        composeArtStyle(style),
        "",
        "No text, no words, no letters, no captions, no watermark.",
      ].join("\n"),
      aspectRatio: "16:9",
      size: SAMPLE_SIZE,
    });

    await writeFile(path, image.data);
    console.log(`drew       ${style.id} (${image.model})`);
  }
}

void main();
