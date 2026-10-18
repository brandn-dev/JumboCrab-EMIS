import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      allowedOrigins: [
        "192.168.0.18:3000",
        "10.147.13.191:3000",
        "localhost:3000",
        "*.app.github.dev",
      ],
    },
  },
  turbopack: {
    root: __dirname,
  },
  webpack: (config, { isServer, webpack }) => {
    config.resolve = config.resolve ?? {};
    config.resolve.alias = {
      ...config.resolve.alias,
      encoding: false,
    };
    config.plugins = config.plugins ?? [];
    config.plugins.push(
      new webpack.IgnorePlugin({
        resourceRegExp: /^encoding$/,
      }),
    );

    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        encoding: false,
        fs: false,
      };
    }

    return config;
  },
  allowedDevOrigins: ["192.168.0.18", "10.147.13.191"],
};

export default nextConfig;
