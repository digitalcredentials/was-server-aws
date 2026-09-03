import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({});

export const lambdaHandler = async (event) => {
    if (event.httpMethod !== 'PUT') {
        return { statusCode: 405, headers: { Allow: 'PUT' }, body: JSON.stringify({ message: 'Method Not Allowed' }) };
    }

    const { pathParameters, body, headers } = event;
    const { space_id, collection_id, resource_id } = pathParameters;

    try {
        const contentType = headers?.['Content-Type'] ?? headers?.['content-type'];
        await s3.send(new PutObjectCommand({
            Bucket: space_id,
            Key: `collections/${collection_id}/${resource_id}`,
            Body: body ?? '',
            ...(contentType && { ContentType: contentType }),
        }));
        return { statusCode: 200, body: JSON.stringify({ message: 'OK' }) };
    } catch (err) {
        if (err.name === 'NoSuchBucket') {
            return { statusCode: 404, body: JSON.stringify({ message: 'Not found' }) };
        }
        throw err;
    }
};
