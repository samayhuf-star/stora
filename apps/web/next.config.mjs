/** @type {import('next').NextConfig} */
export default {
  serverExternalPackages: ['@electric-sql/pglite', 'postgres', 'pg', '@stora-sh/db', '@stora-sh/runtime', '@stora-sh/agents', '@stora-sh/analyzer', '@stora-sh/aso', '@stora-sh/compliance'],
  poweredByHeader: false,
  typescript: { ignoreBuildErrors: false },
};
