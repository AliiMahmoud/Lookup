#!/bin/bash
# Starts the local database servers the engine tests use (Linux container). See CLAUDE.md.
pg_ctlcluster 16 main start 2>/dev/null
if ! mysqladmin -ulookup -plookup -h127.0.0.1 status >/dev/null 2>&1; then
  mkdir -p /run/mysqld && chown mysql:mysql /run/mysqld
  (nohup mysqld_safe >/dev/null 2>&1 &)
fi
if command -v clickhouse >/dev/null && ! curl -s -m 2 http://127.0.0.1:8123/ping >/dev/null; then
  (cd /opt/ch/data && nohup clickhouse server -- --path=/opt/ch/data/ --http_port=8123 --tcp_port=9000 --listen_host=127.0.0.1 \
    --logger.log=/opt/ch/data/log.txt --logger.errorlog=/opt/ch/data/err.txt \
    --user_directories.users_xml.path=/opt/ch/data/lookup-users.xml >/opt/ch/data/out.txt 2>&1 &)
fi
if command -v redis-server >/dev/null && ! redis-cli -p 6379 --user lookup --pass lookup --no-auth-warning ping >/dev/null 2>&1; then
  mkdir -p /opt/redis && printf 'user default on nopass ~* &* +@all\nuser lookup on >lookup ~* &* +@all\n' > /opt/redis/users.acl
  redis-server --daemonize yes --port 6379 --bind 127.0.0.1 --save '' --appendonly no --aclfile /opt/redis/users.acl --dir /opt/redis --logfile /opt/redis/redis.log
fi
# Redis Cluster for redis-cluster-test.js: 3 masters on 7000-7002, no replicas.
if command -v redis-server >/dev/null && ! redis-cli -p 7000 --user lookup --pass lookup --no-auth-warning ping >/dev/null 2>&1; then
  mkdir -p /opt/rcluster
  for p in 7000 7001 7002; do
    mkdir -p /opt/rcluster/$p
    redis-server --daemonize yes --port $p --bind 127.0.0.1 --cluster-enabled yes --cluster-config-file /opt/rcluster/$p/nodes.conf \
      --dir /opt/rcluster/$p --save '' --appendonly no --aclfile /opt/redis/users.acl --logfile /opt/rcluster/$p/log.txt
  done
  sleep 1
  if ! redis-cli -p 7000 --user lookup --pass lookup --no-auth-warning cluster info 2>/dev/null | grep -q 'cluster_state:ok'; then
    redis-cli --user lookup --pass lookup --no-auth-warning --cluster create 127.0.0.1:7000 127.0.0.1:7001 127.0.0.1:7002 --cluster-replicas 0 --cluster-yes >/dev/null 2>&1
  fi
fi
# MongoDB-compatible server for mongodb-test.js / smoke-mongodb.js: FerretDB (SQLite backend) on 27017, no auth.
# The static binary comes from GitHub releases (fastdl.mongodb.org is blocked here), unpacked in /opt/ferretdb.
if [ -x /opt/ferretdb/ferretdb ] && ! (exec 3<>/dev/tcp/127.0.0.1/27017) 2>/dev/null; then
  mkdir -p /opt/ferretdb/data
  (cd /opt/ferretdb && nohup ./ferretdb --handler=sqlite --sqlite-url=file:/opt/ferretdb/data/ --listen-addr=127.0.0.1:27017 \
    --telemetry=disable --log-level=warn > /opt/ferretdb/log.txt 2>&1 &)
fi
for i in $(seq 1 20); do
  pg_isready -q -h 127.0.0.1 && mysqladmin -ulookup -plookup -h127.0.0.1 status >/dev/null 2>&1 && curl -s -m 2 http://127.0.0.1:8123/ping >/dev/null && break
  sleep 1
done
echo "PostgreSQL: $(pg_isready -h 127.0.0.1 | sed 's/.*- //') · MariaDB: $(mysqladmin -ulookup -plookup -h127.0.0.1 ping 2>/dev/null) · ClickHouse: $(curl -s -m 2 http://127.0.0.1:8123/ping) · Redis: $(redis-cli -p 6379 --user lookup --pass lookup --no-auth-warning ping 2>/dev/null) · Redis Cluster: $(redis-cli -p 7000 --user lookup --pass lookup --no-auth-warning cluster info 2>/dev/null | grep cluster_state | tr -d '\r') · MongoDB (FerretDB): $( (exec 3<>/dev/tcp/127.0.0.1/27017) 2>/dev/null && echo up || echo down)"
