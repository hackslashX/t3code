# Disposable Phase 0 routing/storage spike. Not a production deployment.
apiVersion: v1
kind: Namespace
metadata:
  name: t3-workspace-spike
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/warn: restricted
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: workspace
  namespace: t3-workspace-spike
automountServiceAccountToken: false
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: workspace
  namespace: t3-workspace-spike
  labels:
    hosted.t3.codes/spike: phase-0
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: ${STORAGE_CLASS}
  resources:
    requests:
      storage: ${PVC_SIZE}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: workspace
  namespace: t3-workspace-spike
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app.kubernetes.io/name: t3-workspace-spike
  template:
    metadata:
      labels:
        app.kubernetes.io/name: t3-workspace-spike
    spec:
      serviceAccountName: workspace
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: t3
          image: ${T3_IMAGE}
          imagePullPolicy: IfNotPresent
          args: ["serve", "--host", "0.0.0.0"]
          ports:
            - {name: t3-http, containerPort: 3773}
          resources:
            requests: {cpu: 250m, memory: 512Mi, ephemeral-storage: 1Gi}
            limits: {cpu: "2", memory: 4Gi, ephemeral-storage: 4Gi}
          securityContext:
            allowPrivilegeEscalation: false
            capabilities: {drop: [ALL]}
          volumeMounts:
            - {name: workspace, mountPath: /workspace}
            - {name: t3-home, mountPath: /home/workspace/.t3}
            - {name: tmp, mountPath: /tmp}
        - name: code-server
          image: ${CODE_SERVER_IMAGE}
          imagePullPolicy: IfNotPresent
          args: ["--bind-addr", "0.0.0.0:3000", "--auth", "none", "/workspace"]
          ports:
            - {name: ide-http, containerPort: 3000}
          resources:
            requests: {cpu: 250m, memory: 512Mi, ephemeral-storage: 1Gi}
            limits: {cpu: "2", memory: 4Gi, ephemeral-storage: 4Gi}
          securityContext:
            allowPrivilegeEscalation: false
            capabilities: {drop: [ALL]}
          volumeMounts:
            - {name: workspace, mountPath: /workspace}
            - {name: tmp, mountPath: /tmp}
      volumes:
        - name: workspace
          persistentVolumeClaim: {claimName: workspace}
        - name: t3-home
          emptyDir: {}
        - name: tmp
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: workspace
  namespace: t3-workspace-spike
spec:
  selector:
    app.kubernetes.io/name: t3-workspace-spike
  ports:
    - {name: ide-http, port: 3000, targetPort: ide-http}
    - {name: t3-http, port: 3773, targetPort: t3-http}
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: workspace-ide
  namespace: t3-workspace-spike
spec:
  parentRefs:
    - name: ${GATEWAY_NAME}
      namespace: ${GATEWAY_NAMESPACE}
  hostnames: ["${WORKSPACE_HOST}"]
  rules:
    - matches:
        - path: {type: PathPrefix, value: /}
      backendRefs:
        - {name: workspace, port: 3000}
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: workspace-t3
  namespace: t3-workspace-spike
spec:
  parentRefs:
    - name: ${GATEWAY_NAME}
      namespace: ${GATEWAY_NAMESPACE}
  hostnames: ["t3-${WORKSPACE_HOST}"]
  rules:
    - matches:
        - path: {type: PathPrefix, value: /}
      backendRefs:
        - {name: workspace, port: 3773}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny
  namespace: t3-workspace-spike
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
---
# The spike starts default-deny. Add a cluster-specific policy only after
# discovery identifies Traefik/Gateway pod and namespace labels plus DNS needs.
# Guessing those selectors would either break the route or weaken isolation.
