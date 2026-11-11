// Environment the handler reads at module load; imported before the handler.
process.env.SPACE_URL_BASE = "http://localhost:3000/space";
process.env.SPACES_TABLE_NAME = "was-spaces";
process.env.COUPONS_TABLE_NAME = "was-coupons";
process.env.INSTANCE_VERSION = "test";
process.env.ID_DOMAIN = "id.test";
// The feed queue the sweep hands its synthetic events to (a fake in tests)
process.env.FEED_QUEUE_URL = "https://sqs.test/was-feed.fifo";
// This server's own host, for the self-hosted did:webvh form
process.env.API_HOST = "localhost:3000";
