// Test preload: a daemon process that reports another OS (HIVE_TEST_PLATFORM).
Object.defineProperty(process, "platform", { value: process.env.HIVE_TEST_PLATFORM });
