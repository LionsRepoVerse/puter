import { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { FauxqsServer, startFauxqs } from 'fauxqs';
import { Agent as httpsAgent } from 'node:https';

// Configuration
const s3Endpoint = process.env.S3_ENDPOINT;
const s3Credentials = process.env.S3_CREDENTIALS ? JSON.parse(process.env.S3_CREDENTIALS) : undefined;
const useProviderChain = process.env.S3_USE_PROVIDER_CHAIN === 'true';

let awsClientConfig: Partial<S3ClientConfig>;
let fauxqsServer: FauxqsServer;
let configInitialized = false;

const initializeConfig = async () => {
    if ( configInitialized ) return;

    // Check if we should use fauxqs (no endpoint and no credentials configured)
    const shouldUseS3Endpoint = s3Endpoint && s3Credentials;

    if ( useProviderChain ) {
        awsClientConfig = {
            credentials: fromNodeProviderChain(),
        };
    } else if ( shouldUseS3Endpoint ) {
        awsClientConfig = {
            endpoint: s3Endpoint,
            credentials: s3Credentials,
        };
    } else {
        // Development mode - start fauxqs
        fauxqsServer = await startFauxqs({
            port: 4566,
            logger: false,
            s3StorageDir: './fauxqs-s3-data',
            init: {
                region: 'us-west-2',
                buckets: [
                    'puter-local',
                ],
            },
        });

        awsClientConfig = {
            endpoint: fauxqsServer.address,
            credentials: {
                accessKeyId: 'fakeAccessKeyId',
                secretAccessKey: 'fakeSecretAccessKey',
            },
        };

        // Gracefully stop server on SIGINT, SIGTERM, or SIGABRT
        const shutdown = async () => {
            if ( fauxqsServer ) {
                await fauxqsServer.stop();
            }
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
        process.on('SIGABRT', shutdown);
    }
    configInitialized = true;
};

initializeConfig();

const s3ClientMap = new Map<string, S3Client>();

export const s3ClientProvider = (region: string = 'us-west-2') => {
    // Initialize config on first call

    if ( s3ClientMap.has(region) ) {
        return s3ClientMap.get(region)!;
    }

    try {
        const s3Client = new S3Client({
            region,
            requestStreamBufferSize: 32 * 1024,
            requestHandler: new NodeHttpHandler({
                socketTimeout: 5000,
                httpsAgent: new httpsAgent({
                    maxSockets: 500,
                    keepAlive: true,
                    keepAliveMsecs: 1000,
                }),
            }),
            ...awsClientConfig,
        });

        s3ClientMap.set(region, s3Client);
        return s3Client;
    } catch ( error ) {
        console.error('Failed to create S3 client:', error);
        throw new Error(`Failed to initialize S3 client for region ${region}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
};
