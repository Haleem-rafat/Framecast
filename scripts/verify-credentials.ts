/**
 * Proves that every stored provider credential still decrypts on this machine.
 *
 * This is the one check in the migration that cannot be undone if it fails.
 * `CREDENTIAL_ENCRYPTION_KEY` is what decrypts these rows; carrying the
 * database without carrying that exact key turns every saved API key into
 * unreadable bytes, with no way back. A wrong key is silent — nothing errors
 * until the first render tries to talk to a provider.
 *
 * Prints only the length and last four characters, both of which are already
 * stored in the clear as `keyLastFour`, so the secret itself never reaches a
 * log or a terminal.
 *
 * One-shot: delete it once the migration is verified.
 */
async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { decryptSecret } = await import("@/lib/crypto");

  const rows = await prisma.providerCredential.findMany({
    where: { deletedAt: null },
    select: { provider: true, encryptedKey: true, keyLastFour: true },
  });

  if (rows.length === 0) {
    console.log("No stored credentials to check.");
    await prisma.$disconnect();
    return;
  }

  let failed = 0;

  for (const row of rows) {
    try {
      const plain = decryptSecret(row.encryptedKey);
      const tail = plain.slice(-4);
      const matches = tail === row.keyLastFour;
      console.log(
        `${row.provider}: DECRYPTS OK (${plain.length} chars, ends ${tail}, ` +
          `matches stored keyLastFour: ${matches ? "yes" : "NO"})`,
      );
      if (!matches) failed += 1;
    } catch (error) {
      failed += 1;
      console.log(
        `${row.provider}: FAILED — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  console.log(`\n${rows.length - failed}/${rows.length} credential(s) verified.`);
  await prisma.$disconnect();

  if (failed > 0) {
    console.error("STOP: CREDENTIAL_ENCRYPTION_KEY does not match this data.");
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
