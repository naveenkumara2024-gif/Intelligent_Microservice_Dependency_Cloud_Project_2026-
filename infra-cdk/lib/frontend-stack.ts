import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { ORIGIN_HEADER } from '../../src/lambda-transformer/src/api/names';

/** Output of `npm run build` in src/web-dashboard (Vite). */
export const DASHBOARD_DIST = path.join(__dirname, '..', '..', 'src', 'web-dashboard', 'dist');

export interface FrontendStackProps extends cdk.StackProps {
  /** The dashboard API (ApiStack). */
  readonly api: apigwv2.IHttpApi;
  /** The secret whose value CloudFront must send in the origin header (ApiStack). */
  readonly originSecret: secretsmanager.ISecret;
}

/**
 * Stage 13: the dashboard site.
 *
 *   Browser -> CloudFront -+- /*      -> private S3 bucket (Origin Access Control): the SPA
 *                          '- /api/*  -> ApiStack's HTTP API, with the origin header added
 *
 * Same origin for browser and API (no CORS). Needs an account allowed to create CloudFront
 * distributions (this one required AWS Support verification, 2026-10-13); ApiStack does not.
 * Everything is removed with the stack.
 */
export class FrontendStack extends cdk.Stack {
  public readonly distribution: cloudfront.Distribution;
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);

    // --- Static site: private bucket behind CloudFront -------------------------------------------
    this.bucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        strictTransportSecurity: { accessControlMaxAge: cdk.Duration.days(365), includeSubdomains: true, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true },
        contentSecurityPolicy: {
          // Cytoscape draws on a canvas; React sets style attributes inline. Nothing is loaded from
          // another origin, and the API is same-origin.
          contentSecurityPolicy:
            "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
          override: true,
        },
      },
    });

    // Honour the Cache-Control the Lambdas send (topology: 5 s; everything else: no-store).
    const apiCachePolicy = new cloudfront.CachePolicy(this, 'ApiCachePolicy', {
      defaultTtl: cdk.Duration.seconds(0),
      minTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.seconds(30),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    const apiOrigin = new origins.HttpOrigin(cdk.Fn.select(2, cdk.Fn.split('/', props.api.apiEndpoint)), {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      customHeaders: { [ORIGIN_HEADER]: props.originSecret.secretValue.unsafeUnwrap() },
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'RCA dashboard',
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      // No minimumProtocolVersion: with the default *.cloudfront.net certificate CloudFront ignores it
      // (a minimum of TLS 1.2 needs a custom domain and certificate, which is out of scope here).
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeaders,
        compress: true,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: apiCachePolicy,
          responseHeadersPolicy: securityHeaders,
          compress: true,
        },
      },
    });

    // --- The built SPA ---------------------------------------------------------------------------
    const built = fs.existsSync(path.join(DASHBOARD_DIST, 'index.html'));
    if (!built) {
      cdk.Annotations.of(this).addWarning(
        `Dashboard build not found at ${DASHBOARD_DIST}; run \`npm run build\` in src/web-dashboard before deploying.`,
      );
    }
    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [
        built
          ? s3deploy.Source.asset(DASHBOARD_DIST)
          : s3deploy.Source.data('index.html', '<!doctype html><title>RCA</title><p>Dashboard not built.</p>'),
      ],
      destinationBucket: this.bucket,
      distribution: this.distribution,
      distributionPaths: ['/*'],
      // The bundle names are content hashed: keep only what the current build references.
      prune: true,
    });

    new cdk.CfnOutput(this, 'DashboardUrl', { value: `https://${this.distribution.distributionDomainName}` });
    new cdk.CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
    new cdk.CfnOutput(this, 'SiteBucketName', { value: this.bucket.bucketName });
  }
}
