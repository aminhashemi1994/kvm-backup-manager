cd /opt/backup-manager
if git pull; then
        pm2 delete Backup-Controller-Backend
else
        echo "nothing to update"
        exit 1
fi
rm -rf /var/www/html/backup-manager-panel/
cd /opt/backup-manager/frontend/
npm run build 
mkdir -p /var/www/html/backup-manager-panel/dist
cp -r /opt/backup-manager/frontend/dist/* /var/www/html/backup-manager-panel/dist/
chown -R www-data:www-data /var/www/html/backup-manager-panel/
nginx -s reload 
cd /opt/backup-manager/controller-backend/
pm2 start server.js --name Backup-Controller-Backend