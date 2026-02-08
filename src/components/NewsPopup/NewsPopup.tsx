/**
 * NewsPopup Component
 *
 * Displays news announcements from meshmonitor.org in a modal popup.
 * Supports markdown content, category badges, pagination, and dismissal.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import type { NewsItem, NewsFeed } from '../../types/ui';
import api from '../../services/api';
import './NewsPopup.css';

interface NewsPopupProps {
  isOpen: boolean;
  onClose: () => void;
  forceShowAll?: boolean;
  isAuthenticated: boolean;
}

export const NewsPopup: React.FC<NewsPopupProps> = ({
  isOpen,
  onClose,
  forceShowAll = false,
  isAuthenticated,
}) => {
  const { t } = useTranslation();
  const [newsItems, setNewsItems] = useState<NewsItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [dontShowAgain, setDontShowAgain] = useState(false);

  // Track the full feed for updating lastSeenNewsId
  const [fullFeed, setFullFeed] = useState<NewsItem[]>([]);

  // Ref to scroll content to top on navigation
  const contentRef = useRef<HTMLDivElement>(null);

  // Fetch news data when popup opens
  useEffect(() => {
    if (!isOpen) return;

    const fetchData = async () => {
      setLoading(true);
      try {
        const feed: NewsFeed = await api.getNewsFeed();
        let status: { lastSeenNewsId: string | null; dismissedNewsIds: string[] } | null = null;

        if (isAuthenticated) {
          status = await api.getUserNewsStatus();
        }

        // Store full feed for later use
        const allItems = feed.items || [];
        setFullFeed(allItems);

        // Filter items based on forceShowAll and user status
        let items = [...allItems];

        if (!forceShowAll && status) {
          const dismissedIds = new Set(status.dismissedNewsIds || []);

          // Find the date of the lastSeenNewsId item to filter out older items
          let lastSeenDate: Date | null = null;
          if (status.lastSeenNewsId) {
            const lastSeenItem = allItems.find(item => item.id === status.lastSeenNewsId);
            if (lastSeenItem) {
              lastSeenDate = new Date(lastSeenItem.date);
            }
          }

          items = items.filter(item => {
            // Always show important items that haven't been dismissed
            if (item.priority === 'important' && !dismissedIds.has(item.id)) {
              return true;
            }
            // Hide dismissed items
            if (dismissedIds.has(item.id)) {
              return false;
            }
            // If we have a lastSeenDate, only show items newer than that
            if (lastSeenDate) {
              const itemDate = new Date(item.date);
              return itemDate > lastSeenDate;
            }
            // No lastSeenDate means show all non-dismissed items (first time user)
            return true;
          });
        }

        setNewsItems(items);
        setCurrentIndex(0);
      } catch (error) {
        console.error('Error fetching news:', error);
        setNewsItems([]);
        setFullFeed([]);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [isOpen, forceShowAll, isAuthenticated]);

  // Reset state when popup closes
  useEffect(() => {
    if (!isOpen) {
      setDontShowAgain(false);
      setCurrentIndex(0);
    }
  }, [isOpen]);

  const handleClose = useCallback(async () => {
    // If "don't show again" is checked and we're authenticated, dismiss ALL currently shown items
    if (dontShowAgain && isAuthenticated && newsItems.length > 0) {
      try {
        for (const item of newsItems) {
          await api.dismissNewsItem(item.id);
        }
      } catch (error) {
        console.error('Error dismissing news items:', error);
      }
    }

    // Update lastSeenNewsId to the most recent item in the feed (so user won't see current items again)
    if (isAuthenticated && fullFeed.length > 0 && !forceShowAll) {
      // Find the most recent item by date
      const sortedItems = [...fullFeed].sort(
        (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
      );
      const mostRecentId = sortedItems[0].id;
      try {
        // Get current status to preserve dismissedNewsIds
        const status = await api.getUserNewsStatus();
        await api.updateUserNewsStatus(mostRecentId, status.dismissedNewsIds || []);
      } catch (error) {
        console.error('Error updating lastSeenNewsId:', error);
      }
    }

    onClose();
  }, [dontShowAgain, isAuthenticated, newsItems, currentIndex, onClose, fullFeed, forceShowAll]);

  const handleNext = useCallback(() => {
    if (currentIndex < newsItems.length - 1) {
      setCurrentIndex(prev => prev + 1);
      // Scroll content to top for new item
      contentRef.current?.scrollTo({ top: 0, behavior: 'instant' });
    } else {
      onClose();
    }
  }, [currentIndex, newsItems.length, onClose]);

  const handlePrevious = useCallback(() => {
    if (currentIndex > 0) {
      setCurrentIndex(prev => prev - 1);
      setDontShowAgain(false);
      // Scroll content to top for new item
      contentRef.current?.scrollTo({ top: 0, behavior: 'instant' });
    }
  }, [currentIndex]);

  const getCategoryLabel = (category: NewsItem['category']): string => {
    switch (category) {
      case 'release':
        return t('news.category.release', 'Release');
      case 'security':
        return t('news.category.security', 'Security');
      case 'feature':
        return t('news.category.feature', 'Feature');
      case 'maintenance':
        return t('news.category.maintenance', 'Maintenance');
      default:
        return category;
    }
  };

  const formatDate = (dateString: string): string => {
    try {
      const date = new Date(dateString);
      return date.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
    } catch {
      return dateString;
    }
  };

  if (!isOpen) return null;

  // Show loading state
  if (loading) {
    return (
      <div className="modal-overlay news-modal-overlay" onClick={handleClose}>
        <div className="modal-content news-modal-content" onClick={e => e.stopPropagation()}>
          <div className="modal-header news-modal-header">
            <h2>{t('news.title', 'News')}</h2>
            <button className="modal-close" onClick={handleClose}>
              &times;
            </button>
          </div>
          <div className="modal-body news-modal-body">
            <div className="news-loading">{t('common.loading', 'Loading...')}</div>
          </div>
        </div>
      </div>
    );
  }

  // No news items
  if (newsItems.length === 0) {
    return (
      <div className="modal-overlay news-modal-overlay" onClick={handleClose}>
        <div className="modal-content news-modal-content" onClick={e => e.stopPropagation()}>
          <div className="modal-header news-modal-header">
            <h2>{t('news.title', 'News')}</h2>
            <button className="modal-close" onClick={handleClose}>
              &times;
            </button>
          </div>
          <div className="modal-body news-modal-body">
            <div className="news-empty">{t('news.no_news', 'No news at this time.')}</div>
          </div>
        </div>
      </div>
    );
  }

  const currentItem = newsItems[currentIndex];
  const isLastItem = currentIndex === newsItems.length - 1;

  return (
    <div className="modal-overlay news-modal-overlay" onClick={handleClose}>
      <div className="modal-content news-modal-content" onClick={e => e.stopPropagation()}>
        <div className="modal-header news-modal-header">
          <div className="news-header-left">
            <h2>{t('news.title', 'News')}</h2>
            {newsItems.length > 1 && (
              <span className="news-pagination">
                {currentIndex + 1} / {newsItems.length}
              </span>
            )}
          </div>
          <button className="modal-close" onClick={handleClose}>
            &times;
          </button>
        </div>

        <div className="modal-body news-modal-body" ref={contentRef}>
          <div className="news-item">
            <div className="news-item-header">
              <span className={`news-category news-category-${currentItem.category}`}>
                {getCategoryLabel(currentItem.category)}
              </span>
              {currentItem.priority === 'important' && (
                <span className="news-priority-important">
                  {t('news.important', 'Important')}
                </span>
              )}
              <span className="news-date">{formatDate(currentItem.date)}</span>
            </div>

            <h3 className="news-item-title">{currentItem.title}</h3>

            <div className="news-item-content">
              <ReactMarkdown>{currentItem.content}</ReactMarkdown>
            </div>
          </div>
        </div>

        <div className="modal-footer news-modal-footer">
          <div className="news-footer-left">
            {isAuthenticated && !forceShowAll && (
              <label className="news-dont-show-checkbox">
                <input
                  type="checkbox"
                  checked={dontShowAgain}
                  onChange={e => setDontShowAgain(e.target.checked)}
                />
                {t('news.do_not_show_again', "Don't show these again")}
              </label>
            )}
          </div>

          <div className="news-footer-right">
            {currentIndex > 0 && (
              <button className="news-button news-button-secondary" onClick={handlePrevious}>
                {t('news.previous', 'Previous')}
              </button>
            )}
            <button className="news-button news-button-primary" onClick={handleNext}>
              {isLastItem ? t('news.close', 'Close') : t('news.next', 'Next')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default NewsPopup;
