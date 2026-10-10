-- Test objects for test/mysql-test.js (recreated on every run, in database lookup_test).
DROP DATABASE IF EXISTS lookup_test;
CREATE DATABASE lookup_test CHARACTER SET utf8mb4;
USE lookup_test;

CREATE TABLE customers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(200) UNIQUE COMMENT 'Login e-mail',
  city VARCHAR(50) DEFAULT 'Cairo',
  created_at DATETIME NOT NULL
) ENGINE=InnoDB COMMENT='People who buy things';

CREATE TABLE orders (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  placed_on DATE NOT NULL,
  placed_at DATETIME(3),
  status ENUM('new','paid','sent') NOT NULL DEFAULT 'new',
  details JSON,
  photo BLOB,
  big BIGINT UNSIGNED,
  `Mixed Case` VARCHAR(20),
  CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE,
  CONSTRAINT orders_amount_chk CHECK (amount >= 0),
  KEY orders_placed_on_idx (placed_on DESC, status)
) ENGINE=InnoDB;

CREATE TABLE audit_log (at DATETIME DEFAULT CURRENT_TIMESTAMP, message TEXT) ENGINE=InnoDB;

INSERT INTO customers (name, email, city, created_at)
WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 200)
SELECT CONCAT('Customer ', n), CONCAT('c', n, '@example.com'), ELT(1 + n % 3, 'Cairo', 'Giza', 'Alexandria'),
       TIMESTAMP('2026-01-01 10:00:00') + INTERVAL n HOUR FROM g;

INSERT INTO orders (customer_id, amount, placed_on, placed_at, status, details, photo, big, `Mixed Case`)
WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 1000)
SELECT 1 + n % 200, ROUND(n * 1.37, 2), DATE('2026-01-01') + INTERVAL n % 90 DAY,
       TIMESTAMP('2026-01-01 08:30:00.123') + INTERVAL n MINUTE, ELT(1 + n % 3, 'new', 'paid', 'sent'),
       JSON_OBJECT('n', n, 'gift', n % 7 = 0), UNHEX('DEADBEEF'), 18446744073709551615 - n, CONCAT('v', n) FROM g;

INSERT INTO audit_log (message) VALUES ('first'), ('second');

CREATE VIEW big_orders AS SELECT o.id, c.name, o.amount FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.amount > 1000;

DELIMITER $$
CREATE PROCEDURE touch_log(IN msg VARCHAR(100))
BEGIN
  INSERT INTO audit_log (message) VALUES (msg);
  SELECT COUNT(*) AS entries FROM audit_log;
END$$
CREATE FUNCTION add_tax(x DECIMAL(12,2)) RETURNS DECIMAL(12,2) DETERMINISTIC
BEGIN
  RETURN x * 1.14;
END$$
CREATE TRIGGER customers_audit AFTER UPDATE ON customers FOR EACH ROW
BEGIN
  INSERT INTO audit_log (message) VALUES ('UPDATE on customers');
END$$
DELIMITER ;
