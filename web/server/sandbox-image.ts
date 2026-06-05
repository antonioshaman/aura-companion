// AURA-LOCAL — fork-owned default sandbox image identity.
//
// The fork does NOT pull this image from any remote registry. Coupling to the
// upstream registry has been removed (see container-manager.getRegistryImage →
// always null). The image is
// produced once and stored as a tarball in the dev-server backup folder,
// then loaded into the local Docker daemon:
//
//   docker save -o /root/backUp/aura-companion-sandbox.tar aura-companion-sandbox:latest
//   docker load -i /root/backUp/aura-companion-sandbox.tar
//
// Once loaded, container-manager finds it locally (imageExists → true) and
// never reaches out to a registry.
export const DEFAULT_SANDBOX_IMAGE = "aura-companion-sandbox:latest";
